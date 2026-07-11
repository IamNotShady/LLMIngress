import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatConsoleActivityFallbackAttempts,
  listConsoleActivities,
} from "../../packages/db/src/console-activity";
import type { TestPostgresFixture } from "../../packages/db/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { recordCompletedGatewayRequestActivity } from "../../packages/gateway-runtime/src/gateway-activity-recorder";

describe("schema fallback single source", () => {
  it("migrated schema removes request_activity.fallback_attempts and adds retry columns", async () => {
    await withMigratedFixture(async (fixture) => {
      await expect(columnExists(fixture, "request_activity", "fallback_attempts")).resolves.toBe(
        false,
      );
      await expect(columnExists(fixture, "fallback_events", "retryable")).resolves.toBe(true);
      await expect(columnExists(fixture, "fallback_events", "status_code")).resolves.toBe(true);
    });
  });

  it("completed activity records fallback retry metadata in fallback_events", async () => {
    await withMigratedFixture(async (fixture) => {
      await ensureFallbackRetryColumns(fixture);
      const ids = await seedRuntimeEntities(fixture);

      await recordCompletedGatewayRequestActivity({
        activityId: randomUUID(),
        agentApiKeyPrefix: "llmi_schema",
        agentId: ids.agentId,
        databaseUrl: fixture.databaseUrl,
        model: "schema-vm",
        protocol: "chat_completions",
        requestId: "req-schema-fallback-record",
        responseBody: {
          error: { code: "provider_request_failed", message: "Provider failed." },
        },
        route: {
          fallbackAttempts: [
            {
              attemptOrder: 1,
              errorCode: "provider_request_failed",
              errorMessage: "Provider failed.",
              failedBeforeFirstByte: true,
              providerModelId: ids.providerModelId,
              retryable: true,
              statusCode: 503,
            },
          ],
          providerId: ids.providerId,
          providerModelId: ids.providerModelId,
          routeReason: { message: "fallback test" },
        },
        startedAt: new Date("2026-07-05T00:00:00.000Z"),
        statusCode: 502,
        stream: false,
        virtualModelId: ids.virtualModelId,
      });

      await expect(readFallbackEventRetryMetadata(fixture)).resolves.toMatchObject({
        retryable: true,
        status_code: 503,
      });
    });
  });

  it("completed activity no longer needs request_activity.fallback_attempts", async () => {
    await withMigratedFixture(async (fixture) => {
      await ensureFallbackRetryColumns(fixture);
      await fixture.query("alter table request_activity drop column if exists fallback_attempts");
      const ids = await seedRuntimeEntities(fixture);

      await expect(
        recordCompletedGatewayRequestActivity({
          activityId: randomUUID(),
          agentApiKeyPrefix: "llmi_schema",
          agentId: ids.agentId,
          databaseUrl: fixture.databaseUrl,
          model: "schema-vm",
          protocol: "chat_completions",
          requestId: "req-schema-no-jsonb",
          responseBody: { id: "ok" },
          route: {
            fallbackAttempts: [],
            providerId: ids.providerId,
            providerModelId: ids.providerModelId,
          },
          startedAt: new Date("2026-07-05T00:00:00.000Z"),
          statusCode: 200,
          stream: false,
          virtualModelId: ids.virtualModelId,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("console activity list derives failed-attempt counts from fallback_events", async () => {
    await withMigratedFixture(async (fixture) => {
      await ensureFallbackRetryColumns(fixture);
      const { activityId } = await seedFailedActivityWithFallbackEvents(fixture);

      const activities = await listConsoleActivities({
        databaseUrl: fixture.databaseUrl,
        filters: { requestId: "req-schema-fallback-list" },
      });

      expect(activities).toHaveLength(1);
      expect(activities[0]?.id).toBe(activityId);
      const activity = activities[0] as { fallbackFailedAttemptCount?: number } | undefined;
      expect(activity?.fallbackFailedAttemptCount).toBe(3);
    });
  });

  it("formats fallback attempt lines from fallback event rows", () => {
    expect(
      formatConsoleActivityFallbackAttempts([
        {
          attemptOrder: 1,
          createdAt: new Date("2026-07-05T00:00:00.000Z"),
          errorCode: "provider_request_failed",
          errorMessage: "failed",
          failedBeforeFirstByte: true,
          providerApiKeyId: null,
          providerApiKeyPrefix: null,
          providerModelDisplayName: "Schema Model",
          providerModelId: "provider-model-1",
          providerModelName: "gpt-schema",
          status: "failed",
        },
      ]),
    ).toEqual(["Attempt 1: provider_request_failed before first byte on provider-model-1"]);
  });
});

async function withMigratedFixture<T>(
  run: (fixture: TestPostgresFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_fallback_source_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    return await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function ensureFallbackRetryColumns(fixture: TestPostgresFixture): Promise<void> {
  await fixture.query(
    "alter table fallback_events add column if not exists retryable boolean, add column if not exists status_code integer",
  );
}

async function seedRuntimeEntities(fixture: TestPostgresFixture) {
  const ids = {
    agentId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await fixture.query(
    "insert into agents (id, name, key_prefix) values ($1, 'Schema Agent', 'llmi_schema')",
    [ids.agentId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'schema-vm', 'Schema VM', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openai', 'OpenAI', true)",
    [ids.providerId],
  );
  await fixture.query(
    "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, 'gpt-schema', 'Schema Model')",
    [ids.providerModelId, ids.providerId],
  );
  return ids;
}

async function seedFailedActivityWithFallbackEvents(fixture: TestPostgresFixture) {
  const ids = await seedRuntimeEntities(fixture);
  const activityId = randomUUID();
  await fixture.query(
    `
      insert into request_activity (
        id, request_id, agent_id, virtual_model_id, provider_id,
        provider_model_id, agent_key_prefix, protocol, model, stream,
        status, error_code, error_message, http_status, latency_ms,
        started_at, completed_at, created_at
      )
      values (
        $1, 'req-schema-fallback-list', $2, $3, $4, $5, 'llmi_schema',
        'chat_completions', 'schema-vm', false, 'failed',
        'provider_request_failed', 'failed', 502, 10,
        '2026-07-05T00:00:00.000Z'::timestamptz,
        '2026-07-05T00:00:01.000Z'::timestamptz,
        '2026-07-05T00:00:00.000Z'::timestamptz
      )
    `,
    [activityId, ids.agentId, ids.virtualModelId, ids.providerId, ids.providerModelId],
  );
  for (const [attemptOrder, statusCode] of [503, 502, 400].entries()) {
    await fixture.query(
      `
        insert into fallback_events (
          id, request_activity_id, provider_model_id, attempt_order, status,
          error_code, error_message, failed_before_first_byte, retryable, status_code
        )
        values (
          $1, $2, $3, $4, 'failed', 'provider_request_failed', 'failed',
          true, $5, $6
        )
      `,
      [
        randomUUID(),
        activityId,
        ids.providerModelId,
        attemptOrder + 1,
        statusCode >= 500,
        statusCode,
      ],
    );
  }
  await fixture.query(
    `
      insert into fallback_events (
        id, request_activity_id, provider_model_id, attempt_order, status,
        failed_before_first_byte, retryable, status_code
      )
      values ($1, $2, $3, 4, 'succeeded', false, null, null)
    `,
    [randomUUID(), activityId, ids.providerModelId],
  );
  return { ...ids, activityId };
}

async function columnExists(
  fixture: TestPostgresFixture,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await fixture.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = $2
      )
    `,
    [tableName, columnName],
  );
  return result.rows[0]?.exists ?? false;
}

async function readFallbackEventRetryMetadata(fixture: TestPostgresFixture) {
  const result = await fixture.query<{ retryable: boolean | null; status_code: number | null }>(
    `
      select retryable, status_code
      from fallback_events
      order by attempt_order
      limit 1
    `,
  );
  return result.rows[0];
}
