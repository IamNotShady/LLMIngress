import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getConsoleUsageBreakouts } from "../../packages/db/src/console-usage.ts";
import {
  createTestPostgresFixture,
  runMigrations,
  type TestPostgresFixture,
} from "../../packages/db/src/index.ts";

type Ids = { apiKeyId: string; modelId: string; providerId: string; virtualModelId: string };

async function seed(fixture: TestPostgresFixture): Promise<Ids> {
  const ids: Ids = {
    apiKeyId: randomUUID(),
    modelId: randomUUID(),
    providerId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await fixture.query(
    "insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'k', 'llmi_k', gen_random_uuid()::text)",
    [ids.apiKeyId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'vm', 'VM', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openrouter', 'openrouter', true)",
    [ids.providerId],
  );
  await fixture.query(
    "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, 'm', 'm')",
    [ids.modelId, ids.providerId],
  );
  return ids;
}

async function addRequest(
  fixture: TestPostgresFixture,
  ids: Ids,
  row: {
    attempts?: Array<{ order: number; status: string; errorCode?: string }>;
    costSource?: string;
    errorCode?: string;
    httpStatus?: number;
    latencyMs?: number;
    protocol?: string;
    status: "canceled" | "failed" | "succeeded";
    stream?: boolean;
    tokenSource?: string;
  },
): Promise<void> {
  const activityId = randomUUID();
  await fixture.query(
    `insert into request_activity
       (id, request_id, api_key_id, virtual_model_id, provider_id, provider_model_id,
        api_key_prefix, protocol, status, stream, error_code, http_status, latency_ms, started_at)
     values ($1, $2, $3, $4, $5, $6, 'llmi_k', $7, $8, $9, $10, $11, $12, now() - interval '1 hour')`,
    [
      activityId,
      `req_${activityId.slice(0, 8)}`,
      ids.apiKeyId,
      ids.virtualModelId,
      ids.providerId,
      ids.modelId,
      row.protocol ?? "chat_completions",
      row.status,
      row.stream ?? true,
      row.errorCode ?? null,
      row.httpStatus ?? null,
      row.latencyMs ?? 1000,
    ],
  );
  await fixture.query(
    `insert into request_usage
       (id, request_activity_id, api_key_id, virtual_model_id, provider_model_id,
        input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens, token_source)
     values (gen_random_uuid(), $1, $2, $3, $4, 100, 50, 150, 40, 10, $5)`,
    [activityId, ids.apiKeyId, ids.virtualModelId, ids.modelId, row.tokenSource ?? "provider"],
  );
  if (row.costSource) {
    await fixture.query(
      `insert into request_costs (id, request_activity_id, api_key_id, total_cost_usd, cost_source)
       values (gen_random_uuid(), $1, $2, 1.5, $3)`,
      [activityId, ids.apiKeyId, row.costSource],
    );
  }
  for (const attempt of row.attempts ?? []) {
    await fixture.query(
      `insert into fallback_events
         (id, request_activity_id, attempt_order, provider_model_id, status, error_code, failed_before_first_byte)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, true)`,
      [activityId, attempt.order, ids.modelId, attempt.status, attempt.errorCode ?? null],
    );
  }
}

describe("console usage breakouts", () => {
  it("reports the distributions the Usage page needs from one window", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_breakouts_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const ids = await seed(fixture);

      await addRequest(fixture, ids, { costSource: "provider", status: "succeeded" });
      await addRequest(fixture, ids, {
        costSource: "estimated",
        protocol: "messages",
        status: "succeeded",
        stream: false,
        tokenSource: "estimated",
      });
      await addRequest(fixture, ids, {
        errorCode: "rate_limit",
        httpStatus: 429,
        status: "failed",
      });
      await addRequest(fixture, ids, { status: "canceled" });

      const breakouts = await getConsoleUsageBreakouts({
        databaseUrl: fixture.databaseUrl,
        window: "24h",
      });

      expect(
        breakouts.tokenSources.find((entry) => entry.source === "provider")?.requestCount,
      ).toBe(3);
      expect(
        breakouts.tokenSources.find((entry) => entry.source === "estimated")?.requestCount,
      ).toBe(1);
      expect(
        breakouts.costSources.find((entry) => entry.source === "estimated")?.totalCostUsd,
      ).toBe("1.50000000");
      expect(breakouts.protocols.find((entry) => entry.protocol === "messages")?.requestCount).toBe(
        1,
      );
      expect(breakouts.statuses.find((entry) => entry.status === "failed")?.requestCount).toBe(1);
      expect(breakouts.streaming.streamed).toBe(3);
      expect(breakouts.streaming.nonStreamed).toBe(1);
      expect(breakouts.topErrors[0]).toMatchObject({
        count: 1,
        errorCode: "rate_limit",
        httpStatus: 429,
      });
      // Requests with no cost row are unmetered, not zero-cost.
      expect(
        breakouts.costSources.find((entry) => entry.source === "unavailable")?.requestCount,
      ).toBe(2);
    } finally {
      await fixture.dispose();
    }
  });

  it("separates a recovered fallback from one that ran out of candidates", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_fallback_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const ids = await seed(fixture);

      await addRequest(fixture, ids, {
        attempts: [
          { errorCode: "overloaded", order: 1, status: "failed" },
          { order: 2, status: "skipped" },
          { order: 3, status: "succeeded" },
        ],
        status: "succeeded",
      });
      await addRequest(fixture, ids, {
        attempts: [{ errorCode: "rate_limit", order: 1, status: "failed" }],
        errorCode: "rate_limit",
        httpStatus: 429,
        status: "failed",
      });
      await addRequest(fixture, ids, { status: "succeeded" });

      const breakouts = await getConsoleUsageBreakouts({
        databaseUrl: fixture.databaseUrl,
        window: "24h",
      });

      expect(breakouts.fallback.recoveredOnRetry).toBe(1);
      expect(breakouts.fallback.skippedCandidates).toBe(1);
      expect(breakouts.fallback.failedAfterLastCandidate).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });
});
