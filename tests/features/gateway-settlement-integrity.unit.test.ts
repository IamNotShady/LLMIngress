import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  finalizeGatewayBudgetReservation,
  type GatewayBudgetReservation,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "../../packages/db/src/gateway-budgets";
import type { TestPostgresFixture } from "../../packages/db/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createDefaultPeriodicTasks } from "../../packages/db/src/worker-periodic-scheduler";
import { reconcileGatewayConcurrencyWindows } from "../../packages/db/src/worker-stale-concurrency";

describe("gateway settlement integrity", () => {
  it("finalizes pending budget reservations with actual provider usage", async () => {
    await withMigratedFixture(async (fixture) => {
      const seeded = await seedBudgetReservation(fixture, {
        reservedCostUsd: 1,
        reservedInputTokens: 500,
        reservedOutputTokens: 500,
        status: "pending",
      });

      await finalizeGatewayBudgetReservation({
        actual: { costUsd: 0.02, totalTokens: 300 },
        databaseUrl: fixture.databaseUrl,
        reservation: seeded.reservation,
      });

      await expectBudgetPeriod(fixture, seeded.budgetPeriodId, {
        costUsedUsd: 0.02,
        reservedCostUsd: 0,
        reservedTokens: 0,
        tokensUsed: 300,
      });
      await expectBudgetReservation(fixture, seeded.reservation.id, {
        actualCostUsd: 0.02,
        actualTotalTokens: 300,
        status: "finalized",
      });
    });
  });

  it("keeps reserved-estimate finalization when actual usage is unavailable", async () => {
    await withMigratedFixture(async (fixture) => {
      const seeded = await seedBudgetReservation(fixture, {
        reservedCostUsd: 1,
        reservedInputTokens: 500,
        reservedOutputTokens: 500,
        status: "pending",
      });

      await finalizeGatewayBudgetReservation({
        databaseUrl: fixture.databaseUrl,
        reservation: seeded.reservation,
      });

      await expectBudgetPeriod(fixture, seeded.budgetPeriodId, {
        costUsedUsd: 1,
        reservedCostUsd: 0,
        reservedTokens: 0,
        tokensUsed: 1000,
      });
    });
  });

  it("late-finalizes an expired reservation with actual provider usage", async () => {
    await withMigratedFixture(async (fixture) => {
      const seeded = await seedBudgetReservation(fixture, {
        budgetReservedCostUsd: 0,
        budgetReservedTokens: 0,
        reservedCostUsd: 1,
        reservedInputTokens: 500,
        reservedOutputTokens: 500,
        status: "expired",
      });

      await finalizeGatewayBudgetReservation({
        actual: { costUsd: 0.02, totalTokens: 300 },
        databaseUrl: fixture.databaseUrl,
        reservation: seeded.reservation,
      });

      await expectBudgetPeriod(fixture, seeded.budgetPeriodId, {
        costUsedUsd: 0.02,
        reservedCostUsd: 0,
        reservedTokens: 0,
        tokensUsed: 300,
      });
      await expectBudgetReservation(fixture, seeded.reservation.id, {
        actualCostUsd: 0.02,
        actualTotalTokens: 300,
        status: "finalized",
      });
    });
  });

  it("leaves expired reservations unchanged when released", async () => {
    await withMigratedFixture(async (fixture) => {
      const seeded = await seedBudgetReservation(fixture, {
        budgetReservedCostUsd: 0,
        budgetReservedTokens: 0,
        reservedCostUsd: 1,
        reservedInputTokens: 500,
        reservedOutputTokens: 500,
        status: "expired",
      });

      await releaseGatewayBudgetReservation({
        databaseUrl: fixture.databaseUrl,
        reservation: seeded.reservation,
      });

      await expectBudgetPeriod(fixture, seeded.budgetPeriodId, {
        costUsedUsd: 0,
        reservedCostUsd: 0,
        reservedTokens: 0,
        tokensUsed: 0,
      });
      await expectBudgetReservation(fixture, seeded.reservation.id, {
        actualCostUsd: null,
        actualTotalTokens: null,
        status: "expired",
      });
    });
  });

  it("uses the configured reservation TTL when reserving budget", async () => {
    const originalTtl = process.env.GATEWAY_BUDGET_RESERVATION_TTL_SECONDS;
    process.env.GATEWAY_BUDGET_RESERVATION_TTL_SECONDS = "60";
    try {
      await withMigratedFixture(async (fixture) => {
        const agentId = await seedAgent(fixture);
        await fixture.query(
          `
            insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
            values ($1, $2, 'budget', 'day', 10, 'usd', true)
          `,
          [randomUUID(), agentId],
        );
        const before = Date.now();

        const decision = await reserveGatewayBudget({
          agentApiKeyId: agentId,
          databaseUrl: fixture.databaseUrl,
          price: pricedModel(),
          requestId: "req-ttl",
          requestMetadata: {
            estimatedInputTokens: 100,
            estimatedOutputTokens: 100,
            messageCount: 1,
            model: "vm",
            protocol: "chat_completions",
            stream: false,
            usesTools: false,
          },
        });

        expect(decision.ok).toBe(true);
        if (!decision.ok || !decision.reservation) {
          return;
        }
        const row = await readReservation(fixture, decision.reservation.id);
        const expiresAt = new Date(row.expires_at).getTime();
        expect(expiresAt - before).toBeGreaterThanOrEqual(55_000);
        expect(expiresAt - before).toBeLessThanOrEqual(65_000);
      });
    } finally {
      if (originalTtl === undefined) {
        delete process.env.GATEWAY_BUDGET_RESERVATION_TTL_SECONDS;
      } else {
        process.env.GATEWAY_BUDGET_RESERVATION_TTL_SECONDS = originalTtl;
      }
    }
  });

  it("reconciles quiet leaked concurrency windows but leaves active windows alone", async () => {
    await withMigratedFixture(async (fixture) => {
      const staleAgentId = await seedAgent(fixture);
      const activeAgentId = await seedAgent(fixture);
      await seedConcurrencyWindow(fixture, staleAgentId, {
        activeCount: 5,
        updatedAgoMinutes: 10,
      });
      await seedConcurrencyWindow(fixture, activeAgentId, {
        activeCount: 7,
        updatedAgoMinutes: 1,
      });

      const result = await reconcileGatewayConcurrencyWindows({
        databaseUrl: fixture.databaseUrl,
        inFlightMaxAgeMinutes: 15,
        quietMinutes: 5,
      });

      expect(result.reconciledWindowCount).toBe(1);
      await expectConcurrencyCount(fixture, staleAgentId, 0);
      await expectConcurrencyCount(fixture, activeAgentId, 7);
    });
  });

  it("registers stale concurrency reconciliation in periodic tasks", () => {
    expect(createDefaultPeriodicTasks()).toContainEqual(
      expect.objectContaining({
        id: "stale-concurrency-reconcile",
        intervalMs: 300_000,
        jobType: "stale_concurrency_reconcile",
      }),
    );
  });
});

type BudgetReservationSeed = {
  budgetReservedCostUsd?: number;
  budgetReservedTokens?: number;
  reservedCostUsd: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  status: "expired" | "pending";
};

async function withMigratedFixture<T>(
  run: (fixture: TestPostgresFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_settlement_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    return await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function seedAgent(fixture: TestPostgresFixture): Promise<string> {
  const agentId = randomUUID();
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Settlement Agent', 'coding', true)",
    [agentId],
  );
  return agentId;
}

async function seedBudgetReservation(
  fixture: TestPostgresFixture,
  input: BudgetReservationSeed,
): Promise<{ budgetPeriodId: string; reservation: GatewayBudgetReservation }> {
  const agentId = await seedAgent(fixture);
  const budgetPeriodId = randomUUID();
  const reservationId = randomUUID();
  const reservedTotalTokens = input.reservedInputTokens + input.reservedOutputTokens;

  await fixture.query(
    `
      insert into budget_periods (
        id,
        agent_id,
        period_type,
        period_start,
        period_end,
        reserved_tokens,
        reserved_cost_usd
      )
      values ($1, $2, 'day', now() - interval '1 hour', now() + interval '23 hours', $3, $4)
    `,
    [
      budgetPeriodId,
      agentId,
      input.budgetReservedTokens ?? reservedTotalTokens,
      input.budgetReservedCostUsd ?? input.reservedCostUsd,
    ],
  );
  await fixture.query(
    `
      insert into budget_reservations (
        id,
        agent_id,
        budget_period_id,
        status,
        reserved_input_tokens,
        reserved_output_tokens,
        reserved_cost_usd,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 hour')
    `,
    [
      reservationId,
      agentId,
      budgetPeriodId,
      input.status,
      input.reservedInputTokens,
      input.reservedOutputTokens,
      input.reservedCostUsd,
    ],
  );

  return {
    budgetPeriodId,
    reservation: {
      budgetPeriodId,
      id: reservationId,
      reservedCostUsd: input.reservedCostUsd,
      reservedInputTokens: input.reservedInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      reservedTotalTokens,
    },
  };
}

async function seedConcurrencyWindow(
  fixture: TestPostgresFixture,
  agentId: string,
  input: { activeCount: number; updatedAgoMinutes: number },
): Promise<void> {
  await fixture.query(
    `
      insert into rate_limit_windows (
        id,
        agent_id,
        limit_type,
        window_start,
        window_end,
        active_count,
        updated_at
      )
      values ($1, $2, 'concurrency', '1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', $3, now() - make_interval(mins => $4))
    `,
    [randomUUID(), agentId, input.activeCount, input.updatedAgoMinutes],
  );
}

async function expectBudgetPeriod(
  fixture: TestPostgresFixture,
  budgetPeriodId: string,
  expected: {
    costUsedUsd: number;
    reservedCostUsd: number;
    reservedTokens: number;
    tokensUsed: number;
  },
): Promise<void> {
  const result = await fixture.query<{
    cost_used_usd: string;
    reserved_cost_usd: string;
    reserved_tokens: string;
    tokens_used: string;
  }>(
    `
      select cost_used_usd::text,
             reserved_cost_usd::text,
             reserved_tokens::text,
             tokens_used::text
      from budget_periods
      where id = $1
    `,
    [budgetPeriodId],
  );
  const row = result.rows[0];
  expect(row).toBeDefined();
  expect(Number(row?.cost_used_usd)).toBe(expected.costUsedUsd);
  expect(Number(row?.reserved_cost_usd)).toBe(expected.reservedCostUsd);
  expect(Number(row?.reserved_tokens)).toBe(expected.reservedTokens);
  expect(Number(row?.tokens_used)).toBe(expected.tokensUsed);
}

async function expectBudgetReservation(
  fixture: TestPostgresFixture,
  reservationId: string,
  expected: {
    actualCostUsd: number | null;
    actualTotalTokens: number | null;
    status: string;
  },
): Promise<void> {
  const row = await readReservation(fixture, reservationId);
  expect(row.status).toBe(expected.status);
  expect(row.actual_total_tokens === null ? null : Number(row.actual_total_tokens)).toBe(
    expected.actualTotalTokens,
  );
  expect(row.actual_cost_usd === null ? null : Number(row.actual_cost_usd)).toBe(
    expected.actualCostUsd,
  );
}

async function readReservation(
  fixture: TestPostgresFixture,
  reservationId: string,
): Promise<{
  actual_cost_usd: string | null;
  actual_total_tokens: string | null;
  expires_at: string;
  status: string;
}> {
  const result = await fixture.query<{
    actual_cost_usd: string | null;
    actual_total_tokens: string | null;
    expires_at: string;
    status: string;
  }>(
    `
      select actual_cost_usd::text,
             actual_total_tokens::text,
             expires_at::text,
             status
      from budget_reservations
      where id = $1
    `,
    [reservationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Reservation ${reservationId} was not found.`);
  }
  return row;
}

async function expectConcurrencyCount(
  fixture: TestPostgresFixture,
  agentId: string,
  expected: number,
): Promise<void> {
  const result = await fixture.query<{ active_count: number }>(
    "select active_count from rate_limit_windows where agent_id = $1 and limit_type = 'concurrency'",
    [agentId],
  );
  expect(result.rows[0]?.active_count).toBe(expected);
}

function pricedModel() {
  return {
    currency: "USD" as const,
    inputUsdPerMillionTokens: 1,
    modelId: "fake-model",
    outputUsdPerMillionTokens: 1,
    priceVersion: "test",
    providerKey: "openai",
    snapshotDate: "2026-07-04",
    source: "manual_override" as const,
    sourceUrl: "manual://test",
    status: "priced" as const,
    unit: "per_1m_tokens" as const,
  };
}
