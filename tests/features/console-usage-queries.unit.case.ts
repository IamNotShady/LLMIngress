import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listApiKeys } from "../../packages/db/src/console-api-keys.ts";
import {
  getConsolePreviousWindowKpis,
  getConsoleUsageSummary,
  listConsoleVirtualModelCandidateTraffic,
} from "../../packages/db/src/console-usage.ts";
import {
  createTestPostgresFixture,
  runMigrations,
  type TestPostgresFixture,
} from "../../packages/db/src/index.ts";

type SeedIds = {
  apiKeyId: string;
  providerId: string;
  primaryModelId: string;
  fallbackModelId: string;
  virtualModelId: string;
};

async function seedRuntimeEntities(fixture: TestPostgresFixture): Promise<SeedIds> {
  const ids: SeedIds = {
    apiKeyId: randomUUID(),
    providerId: randomUUID(),
    primaryModelId: randomUUID(),
    fallbackModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await fixture.query(
    "insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'usage-key', 'llmi_usage', gen_random_uuid()::text)",
    [ids.apiKeyId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'coding-fast', 'Coding fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openrouter', 'openrouter', true)",
    [ids.providerId],
  );
  await fixture.query(
    "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, 'claude-sonnet-4-5', 'claude-sonnet-4-5'), ($3, $2, 'deepseek-chat', 'deepseek-chat')",
    [ids.primaryModelId, ids.providerId, ids.fallbackModelId],
  );
  return ids;
}

async function seedActivity(
  fixture: TestPostgresFixture,
  ids: SeedIds,
  row: {
    startedAt: Date;
    status: "canceled" | "failed" | "succeeded";
    providerModelId?: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  },
): Promise<void> {
  const activityId = randomUUID();
  await fixture.query(
    `insert into request_activity
       (id, request_id, api_key_id, virtual_model_id, provider_id, provider_model_id,
        api_key_prefix, protocol, status, started_at)
     values ($1, $2, $3, $4, $5, $6, 'llmi_usage', 'chat_completions', $7, $8)`,
    [
      activityId,
      `req_${activityId.slice(0, 8)}`,
      ids.apiKeyId,
      ids.virtualModelId,
      ids.providerId,
      row.providerModelId ?? ids.primaryModelId,
      row.status,
      row.startedAt.toISOString(),
    ],
  );
  await fixture.query(
    `insert into request_usage
       (id, request_activity_id, api_key_id, virtual_model_id, provider_model_id,
        input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens, token_source)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'provider')`,
    [
      activityId,
      ids.apiKeyId,
      ids.virtualModelId,
      row.providerModelId ?? ids.primaryModelId,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      row.cachedInputTokens ?? 0,
      row.reasoningTokens ?? 0,
    ],
  );
}

describe("console usage queries", () => {
  it("splits each trend bucket into succeeded and failed requests and into its token parts", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_trend_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const ids = await seedRuntimeEntities(fixture);
      const now = new Date("2026-07-25T12:30:00.000Z");
      const inBucket = new Date("2026-07-25T12:05:00.000Z");

      await seedActivity(fixture, ids, {
        startedAt: inBucket,
        status: "succeeded",
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningTokens: 5,
      });
      await seedActivity(fixture, ids, { startedAt: inBucket, status: "failed" });
      await seedActivity(fixture, ids, { startedAt: inBucket, status: "canceled" });

      const summary = await getConsoleUsageSummary({
        databaseUrl: fixture.databaseUrl,
        now,
        window: "24h",
      });
      const bucket = summary.trend.find((point) => point.requestCount > 0);

      expect(bucket).toBeDefined();
      expect(bucket?.requestCount).toBe(3);
      // The stacked request chart draws failed on top of succeeded; canceled is
      // neither, so it must not inflate the failure segment.
      expect(bucket?.failureCount).toBe(1);
      expect(bucket?.inputTokens).toBe(100);
      expect(bucket?.cachedInputTokens).toBe(40);
      expect(bucket?.outputTokens).toBe(20);
      expect(bucket?.reasoningTokens).toBe(5);
    } finally {
      await fixture.dispose();
    }
  });

  it("reports the previous comparable window for every window the Overview offers", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_prevwin_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const ids = await seedRuntimeEntities(fixture);
      const now = new Date("2026-07-25T12:00:00.000Z");

      // Current 24h window: 2 requests. Previous 24h window: 1 request.
      await seedActivity(fixture, ids, {
        startedAt: new Date("2026-07-25T11:00:00.000Z"),
        status: "succeeded",
      });
      await seedActivity(fixture, ids, {
        startedAt: new Date("2026-07-25T02:00:00.000Z"),
        status: "succeeded",
      });
      await seedActivity(fixture, ids, {
        startedAt: new Date("2026-07-24T06:00:00.000Z"),
        status: "failed",
      });
      // Older than both 24h windows but inside the previous 7d window.
      await seedActivity(fixture, ids, {
        startedAt: new Date("2026-07-14T06:00:00.000Z"),
        status: "succeeded",
      });

      const previousDay = await getConsolePreviousWindowKpis({
        databaseUrl: fixture.databaseUrl,
        now,
        window: "24h",
      });
      expect(previousDay.requestCount).toBe(1);

      const previousWeek = await getConsolePreviousWindowKpis({
        databaseUrl: fixture.databaseUrl,
        now,
        window: "7d",
      });
      expect(previousWeek.requestCount).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("attributes traffic to each route candidate of one virtual model", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_candtraffic_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const ids = await seedRuntimeEntities(fixture);
      const now = new Date("2026-07-25T12:00:00.000Z");
      const at = new Date("2026-07-25T11:00:00.000Z");

      await seedActivity(fixture, ids, { startedAt: at, status: "succeeded" });
      await seedActivity(fixture, ids, { startedAt: at, status: "succeeded" });
      await seedActivity(fixture, ids, { startedAt: at, status: "failed" });
      await seedActivity(fixture, ids, {
        startedAt: at,
        status: "succeeded",
        providerModelId: ids.fallbackModelId,
      });

      const traffic = await listConsoleVirtualModelCandidateTraffic({
        databaseUrl: fixture.databaseUrl,
        now,
        virtualModelId: ids.virtualModelId,
        window: "24h",
      });
      const byModel = new Map(traffic.map((entry) => [entry.providerModelId, entry]));

      // The Route table's TRAFFIC 24H bar is per candidate, not per model
      // globally — a model shared by two virtual models must not merge.
      expect(byModel.get(ids.primaryModelId)?.requestCount).toBe(3);
      expect(byModel.get(ids.fallbackModelId)?.requestCount).toBe(1);
      expect(byModel.get(ids.primaryModelId)?.share).toBeCloseTo(0.75, 5);
      expect(byModel.get(ids.fallbackModelId)?.share).toBeCloseTo(0.25, 5);
    } finally {
      await fixture.dispose();
    }
  });

  it("derives an api key's last used moment from its most recent request", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_lastused_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const ids = await seedRuntimeEntities(fixture);

      const [beforeAnyTraffic] = await listApiKeys(fixture.databaseUrl);
      // api_keys has no last_used column — an unused key simply has no traffic.
      expect(beforeAnyTraffic?.lastUsedAt).toBeNull();

      await seedActivity(fixture, ids, {
        startedAt: new Date("2026-07-20T08:00:00.000Z"),
        status: "succeeded",
      });
      await seedActivity(fixture, ids, {
        startedAt: new Date("2026-07-24T09:30:00.000Z"),
        status: "failed",
      });

      const [afterTraffic] = await listApiKeys(fixture.databaseUrl);
      expect(afterTraffic?.lastUsedAt?.toISOString()).toBe("2026-07-24T09:30:00.000Z");
    } finally {
      await fixture.dispose();
    }
  });
});
