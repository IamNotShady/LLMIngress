import { randomUUID } from "node:crypto";
import { saveProviderApiKey } from "@llmingress/db/console-provider-keys";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

const masterKey = "a".repeat(64);

test("saving an API key enqueues model_refresh alongside the connection probe", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_cred_refresh_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'Auto Model Refresh', 'https://provider.test/v1', true)
      `,
      [providerId],
    );

    const result = await saveProviderApiKey({
      databaseUrl: fixture.databaseUrl,
      masterKeySource: { kind: "inline", value: masterKey },
      plaintext: "sk-auto-refresh-test-key-value",
      providerId,
    });

    await enqueueProviderConnectionProbeJob({
      databaseUrl: fixture.databaseUrl,
      providerConnectionId: result.metadata.id,
      providerId,
      resetHealth: true,
      source: "api_key_saved",
    });
    await enqueueProviderModelRefreshJob({
      databaseUrl: fixture.databaseUrl,
      providerId,
      source: "api_key_saved",
      trigger: "system",
    });

    const jobs = await fixture.query<{
      job_type: string;
      payload: Record<string, unknown>;
      trigger: string;
    }>(
      `
        select job_type, trigger, payload
        from jobs
        where payload ->> 'providerId' = $1
        order by job_type
      `,
      [providerId],
    );

    expect(jobs.rows).toEqual(
      expect.arrayContaining([
        {
          job_type: "model_refresh",
          trigger: "system",
          payload: { providerId, source: "api_key_saved" },
        },
        {
          job_type: "provider_connection_probe",
          trigger: "system",
          payload: {
            providerConnectionId: result.metadata.id,
            providerId,
            source: "api_key_saved",
          },
        },
      ]),
    );
  } finally {
    await fixture.dispose();
  }
});

test("oauth_ready model refresh enqueue persists system trigger and source", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_oauth_refresh_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const oauthId = randomUUID();
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'subscription', 'openai_codex', 'OAuth Refresh', 'https://provider.test/v1', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_oauth (
          id, provider_id, label, priority, enabled, encrypted_token, completed_at
        )
        values ($1, $2, 'primary', 0, true, '{"ciphertext":"secret"}'::jsonb, now())
      `,
      [oauthId, providerId],
    );

    await enqueueProviderModelRefreshJob({
      databaseUrl: fixture.databaseUrl,
      providerId,
      source: "oauth_ready",
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
        payload: { providerId, source: "oauth_ready" },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});
