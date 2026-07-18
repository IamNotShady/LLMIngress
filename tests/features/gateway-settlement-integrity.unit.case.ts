import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TestPostgresFixture } from "../../packages/db/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  enforceGatewayApiKeyLimits,
  recordGatewayBudgetUsage,
} from "../../packages/gateway-runtime/src/gateway-api-key-limits";
import { createCoreMaintenanceTasks } from "../../packages/worker-runtime/src/worker-maintenance-scheduler";
import { reconcileGatewayConcurrencyWindows } from "../../packages/worker-runtime/src/worker-stale-concurrency";

describe("gateway settlement integrity", () => {
  it("rejects a cost budget without budget reservation state", async () => {
    await withMigratedFixture(async (fixture) => {
      const apiKeyId = await seedApiKey(fixture);
      await seedApiKeyLimit(fixture, apiKeyId, {
        limitType: "budget",
        limitValue: 0.0001,
        period: "day",
        unit: "usd",
      });

      const decision = await enforceGatewayApiKeyLimits({
        apiKeyId,
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
      const apiKeyId = await seedApiKey(fixture);
      await seedApiKeyLimit(fixture, apiKeyId, {
        limitType: "budget",
        limitValue: 10,
        period: "day",
        unit: "usd",
      });

      const decision = await enforceGatewayApiKeyLimits({
        apiKeyId,
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
        apiKeyId,
        budgetSettlement: decision.budgetSettlement,
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-success",
        usageCost: {
          actualPrice: pricedModel(),
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

      const row = await readLatestBudgetPeriod(fixture, apiKeyId);
      expect(Number(row?.cost_used_usd)).toBe(0.0002);
      expect(Number(row?.tokens_used)).toBe(200);
      expect(await budgetReservationsTableExists(fixture)).toBe(false);
    });
  });

  it("allows unknown-priced budget requests and records tokens with zero cost", async () => {
    await withMigratedFixture(async (fixture) => {
      const apiKeyId = await seedApiKey(fixture);
      await seedApiKeyLimit(fixture, apiKeyId, {
        limitType: "budget",
        limitValue: 10,
        period: "day",
        unit: "usd",
      });

      const unknownPrice = {
        modelId: "unknown-price-model",
        priceVersion: "test-unknown",
        providerKey: "openai",
        reason: "no_current_price" as const,
        status: "unknown_price" as const,
      };
      const decision = await enforceGatewayApiKeyLimits({
        apiKeyId,
        budgetPrice: unknownPrice,
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-unknown-price",
        requestMetadata: requestMetadata({ estimatedInputTokens: 100, estimatedOutputTokens: 100 }),
      });

      expect(decision.ok).toBe(true);
      if (!decision.ok) {
        return;
      }
      await recordGatewayBudgetUsage({
        apiKeyId,
        budgetSettlement: decision.budgetSettlement,
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-unknown-price",
        usageCost: {
          actualPrice: unknownPrice,
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

      const row = await readLatestBudgetPeriod(fixture, apiKeyId);
      expect(Number(row?.cost_used_usd)).toBe(0);
      expect(Number(row?.tokens_used)).toBe(200);
    });
  });

  it("ignores disabled budget limits for start checks and end accounting", async () => {
    await withMigratedFixture(async (fixture) => {
      const apiKeyId = await seedApiKey(fixture);
      await seedApiKeyLimit(fixture, apiKeyId, {
        enabled: false,
        limitType: "budget",
        limitValue: 0.0001,
        period: "day",
        unit: "usd",
      });

      const decision = await enforceGatewayApiKeyLimits({
        apiKeyId,
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
        apiKeyId,
        budgetSettlement: decision.budgetSettlement,
        databaseUrl: fixture.databaseUrl,
        requestId: "req-budget-disabled",
        usageCost: {
          actualPrice: pricedModel(),
          estimatedInputTokens: 100,
          estimatedOutputTokens: 100,
          providerModelId: randomUUID(),
        },
      });

      expect(await readLatestBudgetPeriod(fixture, apiKeyId)).toBeUndefined();
      expect(await budgetReservationsTableExists(fixture)).toBe(false);
    });
  });

  it("reconciles quiet leaked concurrency windows but leaves active windows alone", async () => {
    await withMigratedFixture(async (fixture) => {
      const staleApiKeyId = await seedApiKey(fixture);
      const activeApiKeyId = await seedApiKey(fixture);
      await seedConcurrencyWindow(fixture, staleApiKeyId, {
        activeCount: 5,
        updatedAgoMinutes: 10,
      });
      await seedConcurrencyWindow(fixture, activeApiKeyId, {
        activeCount: 7,
        updatedAgoMinutes: 1,
      });

      const result = await reconcileGatewayConcurrencyWindows({
        databaseUrl: fixture.databaseUrl,
        inFlightMaxAgeMinutes: 15,
        quietMinutes: 5,
      });

      expect(result.reconciledWindowCount).toBe(1);
      await expectConcurrencyCount(fixture, staleApiKeyId, 0);
      await expectConcurrencyCount(fixture, activeApiKeyId, 7);
    });
  });

  it("registers stale concurrency reconciliation as direct maintenance", () => {
    expect(createCoreMaintenanceTasks()).toContainEqual(
      expect.objectContaining({
        id: "stale-concurrency-reconcile",
        intervalMs: 300_000,
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

async function seedApiKey(fixture: TestPostgresFixture): Promise<string> {
  const apiKeyId = randomUUID();
  await fixture.query(
    "insert into api_keys (id, name, key_prefix, key_hash, enabled) values ($1, 'Settlement ApiKey', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true)",
    [apiKeyId],
  );
  return apiKeyId;
}

async function seedApiKeyLimit(
  fixture: TestPostgresFixture,
  apiKeyId: string,
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
      insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      randomUUID(),
      apiKeyId,
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
  apiKeyId: string,
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
      where api_key_id = $1
      order by created_at desc
      limit 1
    `,
    [apiKeyId],
  );
  return result.rows[0];
}

async function seedConcurrencyWindow(
  fixture: TestPostgresFixture,
  apiKeyId: string,
  input: { activeCount: number; updatedAgoMinutes: number },
): Promise<void> {
  await fixture.query(
    `
      insert into rate_limit_windows (
        id,
        api_key_id,
        limit_type,
        window_start,
        window_end,
        active_count,
        updated_at
      )
      values ($1, $2, 'concurrency', '1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', $3, now() - make_interval(mins => $4))
    `,
    [randomUUID(), apiKeyId, input.activeCount, input.updatedAgoMinutes],
  );
}

async function expectConcurrencyCount(
  fixture: TestPostgresFixture,
  apiKeyId: string,
  expected: number,
): Promise<void> {
  const result = await fixture.query<{ active_count: number }>(
    "select active_count from rate_limit_windows where api_key_id = $1 and limit_type = 'concurrency'",
    [apiKeyId],
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
