import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  enforceGatewayAgentLimits,
  recordGatewayBudgetUsage,
} from "../../packages/db/src/gateway-agent-limits";
import type { TestPostgresFixture } from "../../packages/db/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createDefaultPeriodicTasks } from "../../packages/db/src/worker-periodic-scheduler";
import { reconcileGatewayConcurrencyWindows } from "../../packages/db/src/worker-stale-concurrency";

describe("gateway settlement integrity", () => {
  it("rejects a cost budget without budget reservation state", async () => {
    await withMigratedFixture(async (fixture) => {
      const agentId = await seedAgent(fixture);
      await seedAgentLimit(fixture, agentId, {
        limitType: "budget",
        limitValue: 0.0001,
        period: "day",
        unit: "usd",
      });

      const decision = await enforceGatewayAgentLimits({
        agentId,
        budgetPrice: pricedModel(),
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-exceeded",
        requestMetadata: requestMetadata({ estimatedInputTokens: 100, estimatedOutputTokens: 100 }),
      });

      expect(decision).toMatchObject({
        body: { error: { code: "cost_budget_exceeded" } },
        ok: false,
        statusCode: 402,
      });
      expect(await budgetReservationsTableExists(fixture)).toBe(false);
    });
  });

  it("records successful budget usage after the request", async () => {
    await withMigratedFixture(async (fixture) => {
      const agentId = await seedAgent(fixture);
      await seedAgentLimit(fixture, agentId, {
        limitType: "budget",
        limitValue: 10,
        period: "day",
        unit: "usd",
      });

      const decision = await enforceGatewayAgentLimits({
        agentId,
        budgetPrice: pricedModel(),
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-success",
        requestMetadata: requestMetadata({ estimatedInputTokens: 100, estimatedOutputTokens: 100 }),
      });

      expect(decision.ok).toBe(true);
      if (!decision.ok) {
        return;
      }
      await recordGatewayBudgetUsage({
        agentId,
        budgetSettlement: decision.budgetSettlement,
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-success",
        usageCost: {
          actualPrice: pricedModel(),
          baselinePrice: pricedModel(),
          baselineProviderModelId: randomUUID(),
          estimatedInputTokens: 100,
          estimatedOutputTokens: 100,
          providerModelId: randomUUID(),
          providerUsage: {
            cachedInputTokens: 0,
            inputTokens: 120,
            outputTokens: 80,
            reasoningTokens: 0,
          },
        },
      });

      const row = await readLatestBudgetPeriod(fixture, agentId);
      expect(Number(row?.cost_used_usd)).toBe(0.0002);
      expect(Number(row?.tokens_used)).toBe(200);
      expect(await budgetReservationsTableExists(fixture)).toBe(false);
    });
  });

  it("ignores disabled budget limits for start checks and end accounting", async () => {
    await withMigratedFixture(async (fixture) => {
      const agentId = await seedAgent(fixture);
      await seedAgentLimit(fixture, agentId, {
        enabled: false,
        limitType: "budget",
        limitValue: 0.0001,
        period: "day",
        unit: "usd",
      });

      const decision = await enforceGatewayAgentLimits({
        agentId,
        budgetPrice: pricedModel(),
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-disabled",
        requestMetadata: requestMetadata({ estimatedInputTokens: 100, estimatedOutputTokens: 100 }),
      });

      expect(decision.ok).toBe(true);
      if (!decision.ok) {
        return;
      }
      expect(decision.budgetSettlement).toBeUndefined();
      await recordGatewayBudgetUsage({
        agentId,
        budgetSettlement: decision.budgetSettlement,
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-disabled",
        usageCost: {
          actualPrice: pricedModel(),
          baselinePrice: pricedModel(),
          baselineProviderModelId: randomUUID(),
          estimatedInputTokens: 100,
          estimatedOutputTokens: 100,
          providerModelId: randomUUID(),
        },
      });

      expect(await readLatestBudgetPeriod(fixture, agentId)).toBeUndefined();
      expect(await budgetReservationsTableExists(fixture)).toBe(false);
    });
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
    expect(createDefaultPeriodicTasks()).not.toContainEqual(
      expect.objectContaining({
        jobType: "stale_reservation_cleanup",
      }),
    );
  });
});

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

async function seedAgentLimit(
  fixture: TestPostgresFixture,
  agentId: string,
  input: {
    enabled?: boolean;
    limitType: "budget" | "concurrency" | "rpm" | "token" | "tpm";
    limitValue: number;
    period: string;
    unit: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      randomUUID(),
      agentId,
      input.limitType,
      input.period,
      input.limitValue,
      input.unit,
      input.enabled ?? true,
    ],
  );
}

function requestMetadata(input: { estimatedInputTokens: number; estimatedOutputTokens: number }) {
  return {
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    messageCount: 1,
    model: "vm",
    protocol: "chat_completions" as const,
    stream: false,
    usesTools: false,
  };
}

async function readLatestBudgetPeriod(
  fixture: TestPostgresFixture,
  agentId: string,
): Promise<
  | {
      cost_used_usd: string;
      tokens_used: string;
    }
  | undefined
> {
  const result = await fixture.query<{
    cost_used_usd: string;
    tokens_used: string;
  }>(
    `
      select cost_used_usd::text,
             tokens_used::text
      from budget_periods
      where agent_id = $1
      order by created_at desc
      limit 1
    `,
    [agentId],
  );
  return result.rows[0];
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

async function budgetReservationsTableExists(fixture: TestPostgresFixture): Promise<boolean> {
  const result = await fixture.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'budget_reservations'
      ) as exists
    `,
  );
  return result.rows[0]?.exists ?? false;
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
