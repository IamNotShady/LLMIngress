import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createTestPostgresFixture, runMigrations } from "@llmingress/db";
import type { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import {
  deleteProvider,
  getProviderDependencyImpact,
  setProviderEnabled,
} from "@llmingress/db/console-providers";
import { recordCompletedGatewayRequestActivity } from "@llmingress/gateway-runtime/gateway-activity-recorder";
import { describe, expect, it } from "vitest";

describe("console provider dependency guard", () => {
  it("ships the provider-model reverse dependency lookup index", () => {
    const migrationPath = "packages/db/migrations/0008_provider_dependency_lookup.sql";
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("route_policy_candidates");
    expect(migration).toContain("provider_model_id");
  });

  it("reports active route policy impact and blocks provider disable/delete", async () => {
    const { fixture, ids } = await createSeededProviderDependencyFixture();
    try {
      const impact = await getProviderDependencyImpact({
        databaseUrl: fixture.databaseUrl,
        providerId: ids.providerId,
      });
      expect(impact.providerModels).toEqual([
        {
          id: ids.providerModelId,
          displayName: "Dependency Model",
          modelId: "dependency-model",
        },
      ]);
      expect(impact.routePolicies).toEqual([
        {
          id: ids.routePolicyId,
          virtualModelId: ids.virtualModelId,
          virtualModelName: "Dependency VM",
        },
      ]);
      expect(impact.virtualModels).toEqual([
        {
          id: ids.virtualModelId,
          name: "Dependency VM",
        },
      ]);
      expect(impact.agents).toEqual([
        {
          id: ids.agentId,
          name: "Dependency Agent",
        },
      ]);

      await expect(
        setProviderEnabled({
          databaseUrl: fixture.databaseUrl,
          enabled: false,
          id: ids.providerId,
        }),
      ).rejects.toMatchObject({
        code: "provider_dependency_conflict",
        kind: "conflict",
      } satisfies Partial<ConsoleOperationError>);

      await expect(
        deleteProvider({ databaseUrl: fixture.databaseUrl, id: ids.providerId }),
      ).rejects.toMatchObject({
        code: "provider_dependency_conflict",
        kind: "conflict",
      } satisfies Partial<ConsoleOperationError>);
    } finally {
      await fixture.dispose();
    }
  });

  it("cancels pending provider jobs, blocks running jobs, and cleans runtime data on delete", async () => {
    const { fixture, ids } = await createSeededProviderDependencyFixture({
      withRoutePolicy: false,
    });
    try {
      await fixture.query(
        `
          insert into jobs (id, job_type, status, trigger, payload)
          values ($1, 'provider_connectivity_check', 'running', 'system', $2::jsonb)
        `,
        [randomUUID(), JSON.stringify({ providerId: ids.providerId })],
      );
      await expect(
        deleteProvider({ databaseUrl: fixture.databaseUrl, id: ids.providerId }),
      ).rejects.toMatchObject({ code: "provider_job_running" });

      await fixture.query(
        `
          update jobs
          set status = 'pending'
          where payload->>'providerId' = $1
        `,
        [ids.providerId],
      );
      await fixture.query(
        `
          insert into provider_health_summary (id, provider_id, provider_model_id, status)
          values ($1, $2, null, 'healthy')
        `,
        [randomUUID(), ids.providerId],
      );
      await fixture.query(
        `
          insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
          values ($1, $2, 'sk-test', '{"version":1}'::jsonb, 'key-1')
        `,
        [ids.providerApiKeyId, ids.providerId],
      );

      await deleteProvider({ databaseUrl: fixture.databaseUrl, id: ids.providerId });

      const state = await fixture.query<{
        canceled_jobs: number;
        key_count: number;
        model_deleted: boolean;
        provider_deleted: boolean;
        runtime_health_count: number;
      }>(
        `
          select
            (select count(*)::integer from jobs where payload->>'providerId' = $1::text and status = 'canceled') as canceled_jobs,
            (select count(*)::integer from provider_api_keys where provider_id = $1::uuid) as key_count,
            (select deleted_at is not null from provider_models where id = $2) as model_deleted,
            (select deleted_at is not null from providers where id = $1::uuid) as provider_deleted,
            (select count(*)::integer from provider_health_summary where provider_id = $1::uuid) as runtime_health_count
        `,
        [ids.providerId, ids.providerModelId],
      );
      expect(state.rows[0]).toMatchObject({
        canceled_jobs: 1,
        key_count: 0,
        model_deleted: true,
        provider_deleted: true,
        runtime_health_count: 0,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("does not write dangling provider API key ids when a key disappeared mid-request", async () => {
    const { fixture, ids } = await createSeededProviderDependencyFixture({
      withRoutePolicy: false,
    });
    try {
      await recordCompletedGatewayRequestActivity({
        activityId: randomUUID(),
        agentApiKeyPrefix: "llmi_test",
        agentId: ids.agentId,
        databaseUrl: fixture.databaseUrl,
        model: "dependency-vm",
        protocol: "chat_completions",
        requestId: `req-${randomUUID()}`,
        requestLoggingEnabled: true,
        responseBody: { id: "chatcmpl-test" },
        route: {
          fallbackAttempts: [
            {
              attemptOrder: 1,
              errorCode: "provider_error",
              errorMessage: "failed",
              failedBeforeFirstByte: true,
              providerApiKeyId: ids.providerApiKeyId,
              providerApiKeyPrefix: "sk-test",
              providerModelId: ids.providerModelId,
              retryable: true,
              statusCode: 500,
            },
          ],
          providerApiKeyId: ids.providerApiKeyId,
          providerApiKeyPrefix: "sk-test",
          providerId: ids.providerId,
          providerModelId: ids.providerModelId,
        },
        startedAt: new Date(),
        statusCode: 200,
        stream: false,
        virtualModelId: ids.virtualModelId,
      });

      const rows = await fixture.query<{
        fallback_key_id: string | null;
        request_key_id: string | null;
      }>(
        `
          select request_activity.provider_api_key_id::text as request_key_id,
                 fallback_events.provider_api_key_id::text as fallback_key_id
          from request_activity
          join fallback_events on fallback_events.request_activity_id = request_activity.id
          limit 1
        `,
      );
      expect(rows.rows[0]).toEqual({ fallback_key_id: null, request_key_id: null });
    } finally {
      await fixture.dispose();
    }
  });
});

async function createSeededProviderDependencyFixture(options: { withRoutePolicy?: boolean } = {}) {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_dependency_${randomUUID().replaceAll("-", "_")}`,
  });
  const ids = {
    agentId: randomUUID(),
    providerApiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    routePolicyId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await runMigrations({ databaseUrl: fixture.databaseUrl });
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, enabled)
      values ($1, 'api_key', 'dependency-provider', 'Dependency Provider', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, supports_streaming, supports_function_calling)
      values ($1, $2, 'dependency-model', 'Dependency Model', true, true)
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description)
      values ($1, 'dependency-vm', 'Dependency VM')
    `,
    [ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, key_prefix, key_hash, default_virtual_model_id)
      values ($1, 'Dependency Agent', 'coding', 'llmi_test', 'hash', $2)
    `,
    [ids.agentId, ids.virtualModelId],
  );

  if (options.withRoutePolicy !== false) {
    await fixture.query(
      `
        insert into route_policies (id, virtual_model_id, strategy, rules)
        values ($1, $2, 'fixed', '{"endpointProtocol":"chat_completions"}'::jsonb)
      `,
      [ids.routePolicyId, ids.virtualModelId],
    );
    await fixture.query(
      `
        insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
        values ($1, $2, $3, 1)
      `,
      [randomUUID(), ids.routePolicyId, ids.providerModelId],
    );
  }

  return { fixture, ids };
}
