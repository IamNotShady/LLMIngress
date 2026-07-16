import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { enqueueProviderModelRefreshJob } from "@llmingress/db/provider-jobs";
import { describe, expect, it } from "vitest";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

describe("provider credential model refresh", () => {
  it("enqueues model_refresh with the requested source and system trigger", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_cred_model_refresh_${randomUUID().replaceAll("-", "_")}`,
    });
    const providerId = randomUUID();
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'api_key', 'openai', 'Credential Refresh', 'https://provider.test/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
          values ($1, $2, 'sk-cred', '{"version":1}'::jsonb, 'test-key')
        `,
        [randomUUID(), providerId],
      );

      await enqueueProviderModelRefreshJob({
        databaseUrl: fixture.databaseUrl,
        providerId,
        source: "api_key_saved",
        trigger: "system",
      });

      const jobs = await fixture.query<{
        payload: { providerId: string; source: string };
        trigger: string;
      }>(
        `
          select trigger, payload
          from jobs
          where job_type = 'model_refresh'
            and payload ->> 'providerId' = $1
        `,
        [providerId],
      );
      expect(jobs.rows).toEqual([
        {
          trigger: "system",
          payload: { providerId, source: "api_key_saved" },
        },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("wires provider-keys and provider-oauth routes to enqueue model refresh after credentials are ready", () => {
    const keysRoute = readFileSync("apps/console/src/app/api/provider-keys/route.ts", "utf8");
    const oauthRoute = readFileSync("apps/console/src/app/api/provider-oauth/route.ts", "utf8");

    expect(keysRoute).toContain("enqueueProviderModelRefreshJob");
    expect(keysRoute).toMatch(
      /enqueueProviderConnectionProbeJob\(\{[\s\S]*?source:\s*"api_key_saved"[\s\S]*?\}\)[\s\S]*?enqueueProviderModelRefreshJob\(\{[\s\S]*?source:\s*"api_key_saved"[\s\S]*?trigger:\s*"system"/,
    );
    expect(keysRoute.match(/enqueueProviderModelRefreshJob\(/g)?.length).toBeGreaterThanOrEqual(2);

    expect(oauthRoute).toContain("enqueueProviderModelRefreshJob");
    expect(oauthRoute).toMatch(
      /enqueueProviderConnectionProbeJob\(\{[\s\S]*?source:\s*"oauth_ready"[\s\S]*?\}\)[\s\S]*?enqueueProviderModelRefreshJob\(\{[\s\S]*?source:\s*"oauth_ready"[\s\S]*?trigger:\s*"system"/,
    );
    expect(oauthRoute.match(/enqueueProviderModelRefreshJob\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
