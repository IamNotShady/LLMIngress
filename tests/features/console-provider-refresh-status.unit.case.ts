import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listConsoleProviderModelRefreshStatuses } from "../../packages/db/src/console-providers.ts";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index.ts";

describe("console provider model refresh status", () => {
  it("reports the last refresh failure alongside the last success so the banner can name both", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_refresh_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const providerId = randomUUID();
      await fixture.query(
        "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openrouter', 'openrouter', true)",
        [providerId],
      );
      await fixture.query(
        "insert into provider_models (id, provider_id, model_id, display_name, updated_at) values (gen_random_uuid(), $1, 'claude-sonnet-4-5', 'claude-sonnet-4-5', '2026-07-25T09:00:00Z')",
        [providerId],
      );
      await fixture.query(
        `insert into jobs (id, job_type, status, trigger, payload, completed_at)
         values (gen_random_uuid(), 'model_refresh', 'succeeded', 'scheduled', $1::jsonb, '2026-07-25T09:00:00Z'),
                (gen_random_uuid(), 'model_refresh', 'failed', 'scheduled', $1::jsonb, '2026-07-25T11:00:00Z')`,
        [JSON.stringify({ providerId, source: "scheduled_refresh" })],
      );
      await fixture.query(
        `update jobs set error_code = 'upstream_unauthorized', error_message = '401 from the models endpoint'
         where status = 'failed'`,
      );

      const statuses = await listConsoleProviderModelRefreshStatuses({
        databaseUrl: fixture.databaseUrl,
      });
      const status = statuses.find((entry) => entry.providerId === providerId);

      expect(status?.failure?.errorCode).toBe("upstream_unauthorized");
      expect(status?.failure?.errorMessage).toBe("401 from the models endpoint");
      expect(status?.failure?.at?.toISOString()).toBe("2026-07-25T11:00:00.000Z");
      // The banner says "last refreshed <when>" next to the failure, so a stale
      // but usable model list is still attributable.
      expect(status?.lastSucceededAt?.toISOString()).toBe("2026-07-25T09:00:00.000Z");
      expect(status?.modelsUpdatedAt?.toISOString()).toBe("2026-07-25T09:00:00.000Z");
    } finally {
      await fixture.dispose();
    }
  });

  it("reports no failure once a later refresh succeeds", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_refresh_ok_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const providerId = randomUUID();
      await fixture.query(
        "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openrouter', 'openrouter', true)",
        [providerId],
      );
      await fixture.query(
        `insert into jobs (id, job_type, status, trigger, payload, completed_at, error_code)
         values (gen_random_uuid(), 'model_refresh', 'failed', 'scheduled', $1::jsonb, '2026-07-25T09:00:00Z', 'upstream_unauthorized'),
                (gen_random_uuid(), 'model_refresh', 'succeeded', 'manual', $1::jsonb, '2026-07-25T11:00:00Z', null)`,
        [JSON.stringify({ providerId, source: "manual_refresh" })],
      );

      const statuses = await listConsoleProviderModelRefreshStatuses({
        databaseUrl: fixture.databaseUrl,
      });

      expect(statuses.find((entry) => entry.providerId === providerId)?.failure).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});
