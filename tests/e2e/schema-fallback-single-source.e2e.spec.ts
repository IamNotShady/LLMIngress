import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { listConsoleActivities } from "../../packages/db/src/console-activity";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { recordCompletedGatewayRequestActivity } from "../../packages/gateway-runtime/src/gateway-activity-recorder";

test("fallback_events is the persisted retry-chain source", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_fallback_source_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await expect(columnExists(fixture, "request_activity", "fallback_attempts")).resolves.toBe(
      false,
    );
    await expect(columnExists(fixture, "fallback_events", "retryable")).resolves.toBe(true);
    await expect(columnExists(fixture, "fallback_events", "status_code")).resolves.toBe(true);
    const ids = await seedRuntimeEntities(fixture);
    const activityId = randomUUID();

    await recordCompletedGatewayRequestActivity({
      activityId,
      agentApiKeyPrefix: "llmi_schema",
      agentId: ids.agentId,
      databaseUrl: fixture.databaseUrl,
      model: "schema-vm",
      protocol: "chat_completions",
      requestId: "req-schema-fallback-e2e",
      requestLoggingEnabled: true,
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
      },
      startedAt: new Date("2026-07-05T00:00:00.000Z"),
      statusCode: 502,
      stream: false,
      virtualModelId: ids.virtualModelId,
    });

    await expect(readFallbackEventRetryMetadata(fixture, activityId)).resolves.toMatchObject({
      retryable: true,
      status_code: 503,
    });
    await expect(
      listConsoleActivities({
        databaseUrl: fixture.databaseUrl,
        filters: { requestId: "req-schema-fallback-e2e" },
      }),
    ).resolves.toMatchObject([{ fallbackFailedAttemptCount: 1 }]);
  } finally {
    await fixture.dispose();
  }
});

async function seedRuntimeEntities(fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>) {
  const ids = {
    agentId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await fixture.query(
    "insert into agents (id, name, agent_type, key_prefix) values ($1, 'Schema Agent', 'coding', 'llmi_schema')",
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

async function columnExists(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
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

async function readFallbackEventRetryMetadata(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  activityId: string,
) {
  const result = await fixture.query<{ retryable: boolean | null; status_code: number | null }>(
    `
      select retryable, status_code
      from fallback_events
      where request_activity_id = $1
      order by attempt_order
      limit 1
    `,
    [activityId],
  );
  return result.rows[0];
}
