import { randomUUID } from "node:crypto";
import { saveProviderApiKey } from "@llmingress/db/console-provider-keys";
import { normalizeProviderTemplateFormInput } from "@llmingress/db/console-provider-templates";
import {
  createProvider,
  createProviderFromTemplate,
  normalizeProviderFormInput,
  updateProvider,
} from "@llmingress/db/console-providers";
import { enqueueProviderProbeLifecycleJob } from "@llmingress/db/provider-jobs";
import { createModelRefreshJobHandler } from "@llmingress/worker-runtime/worker-model-refresh";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

const masterKeySource = { kind: "inline", value: "provider-probe-lifecycle-test-key" } as const;

test("remote API key and subscription providers persist editable base URLs", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_base_url_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const apiKeyProvider = await createProvider({
      databaseUrl: fixture.databaseUrl,
      provider: normalizeProviderFormInput({
        baseUrl: "https://proxy.example.test/openai/v1/",
        displayName: "Proxy API Key",
        providerKey: "proxy_api_key",
        providerType: "api_key",
      }),
    });
    expect(apiKeyProvider.baseUrl).toBe("https://proxy.example.test/openai/v1");

    const subscription = await createProviderFromTemplate({
      databaseUrl: fixture.databaseUrl,
      template: normalizeProviderTemplateFormInput({
        baseUrl: "https://proxy.example.test/codex/",
        templateId: "openai_codex",
      }),
    });
    expect(subscription.baseUrl).toBe("https://proxy.example.test/codex");
    const updated = await updateProvider({
      baseUrl: "https://proxy-two.example.test/codex/",
      databaseUrl: fixture.databaseUrl,
      displayName: subscription.displayName,
      id: subscription.id,
    });
    expect(updated).toMatchObject({
      baseUrlChanged: true,
      provider: { baseUrl: "https://proxy-two.example.test/codex" },
    });
  } finally {
    await fixture.dispose();
  }
});

test("API key persistence rejects non-API-key providers without side effects", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_key_type_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'ollama', 'Local Provider', 'http://127.0.0.1:11434/v1', true)
      `,
      [providerId],
    );
    const before = await readMutationCounts(fixture);

    await expect(
      saveProviderApiKey({
        databaseUrl: fixture.databaseUrl,
        masterKeySource,
        plaintext: "sk-should-not-save",
        providerId,
      }),
    ).rejects.toMatchObject({
      code: "provider_api_key_unsupported",
      kind: "validation",
    });

    expect(await readMutationCounts(fixture)).toEqual(before);
  } finally {
    await fixture.dispose();
  }
});

test("every probe refreshes models and commits unknown models with both health scopes", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_probe_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const jobId = randomUUID();
  const requests: string[] = [];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'openai', 'Probe Provider', 'http://provider.test/v1', true)
      `,
      [providerId],
    );

    const handler = createModelRefreshJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith("/models")) {
          return Response.json({ data: [{ id: "unknown-chat" }] });
        }
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      },
      masterKeySource,
      modelPriceSource: async () => [],
      modelRegistrySource: async () => [],
    });
    const job = {
      attemptNumber: 1,
      id: jobId,
      jobType: "model_refresh",
      maxAttempts: 3,
      payload: {
        followUpProbe: true,
        providerId,
        source: "manual_probe",
      },
      priority: 0,
      signal: new AbortController().signal,
      trigger: "manual",
      workerId: "provider-probe-test",
    };
    await handler(job);
    await handler(job);

    expect(requests).toEqual([
      "http://provider.test/v1/models",
      "http://provider.test/v1/chat/completions",
      "http://provider.test/v1/models",
      "http://provider.test/v1/chat/completions",
    ]);
    const state = await fixture.query<{
      context_window: number | null;
      health_event_count: number;
      health_summary_count: number;
      model_id: string;
      provider_model_job_count: number;
    }>(
      `
        select provider_models.model_id,
               provider_models.context_window,
               (select count(*)::integer from provider_health_events where provider_id = $1) as health_event_count,
               (select count(*)::integer from provider_health_summary where provider_id = $1) as health_summary_count,
               (
                 select count(*)::integer
                 from provider_health_events
                 where provider_id = $1
                   and provider_model_id = provider_models.id
                   and job_id = $2
               ) as provider_model_job_count
        from provider_models
        where provider_id = $1
          and model_id = 'unknown-chat'
      `,
      [providerId, jobId],
    );
    expect(state.rows[0]).toEqual({
      context_window: null,
      health_event_count: 2,
      health_summary_count: 2,
      model_id: "unknown-chat",
      provider_model_job_count: 1,
    });
    const connectivityJobs = await fixture.query<{ count: number }>(
      "select count(*)::integer from jobs where job_type = 'provider_connectivity_check'",
    );
    expect(connectivityJobs.rows[0]?.count).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

test("a stale Provider snapshot commits no model or health result", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_probe_stale_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'openai', 'Stale Provider', 'http://provider.test/v1', true)
      `,
      [providerId],
    );
    const handler = createModelRefreshJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async (url) => {
        if (String(url).endsWith("/models")) {
          await fixture.query(
            "update providers set base_url = 'http://changed.test/v1', updated_at = now() where id = $1",
            [providerId],
          );
          return Response.json({ data: [{ id: "stale-chat" }] });
        }
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      },
      masterKeySource,
      modelPriceSource: async () => [],
      modelRegistrySource: async () => [],
    });

    await expect(
      handler({
        attemptNumber: 1,
        id: randomUUID(),
        jobType: "model_refresh",
        maxAttempts: 3,
        payload: { followUpProbe: true, providerId, source: "manual_probe" },
        priority: 0,
        signal: new AbortController().signal,
        trigger: "manual",
        workerId: "provider-probe-stale-test",
      }),
    ).rejects.toMatchObject({ code: "provider_probe_snapshot_stale" });

    const counts = await fixture.query<{ health: number; models: number }>(
      `
        select (select count(*)::integer from provider_models where provider_id = $1) as models,
               (select count(*)::integer from provider_health_events where provider_id = $1) as health
      `,
      [providerId],
    );
    expect(counts.rows[0]).toEqual({ health: 0, models: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("the final probe transaction rolls back models and provider health together", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_probe_rollback_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'openai', 'Rollback Provider', 'http://provider.test/v1', true)
      `,
      [providerId],
    );
    await fixture.query(`
      create function reject_model_health_for_test() returns trigger language plpgsql as $$
      begin
        if new.provider_model_id is not null then
          raise exception 'reject model health';
        end if;
        return new;
      end;
      $$;
      create trigger reject_model_health_for_test
      before insert on provider_health_events
      for each row execute function reject_model_health_for_test();
    `);

    const handler = createModelRefreshJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async (url) =>
        String(url).endsWith("/models")
          ? Response.json({ data: [{ id: "rollback-chat" }] })
          : Response.json({ choices: [{ message: { content: "pong" } }] }),
      masterKeySource,
      modelPriceSource: async () => [],
      modelRegistrySource: async () => [],
    });

    await expect(
      handler({
        attemptNumber: 1,
        id: randomUUID(),
        jobType: "model_refresh",
        maxAttempts: 3,
        payload: { followUpProbe: true, providerId, source: "manual_probe" },
        priority: 0,
        signal: new AbortController().signal,
        trigger: "manual",
        workerId: "provider-probe-rollback-test",
      }),
    ).rejects.toThrow(/reject model health/);

    const counts = await fixture.query<{
      health_events: number;
      health_summaries: number;
      models: number;
    }>(
      `
        select (select count(*)::integer from provider_models where provider_id = $1) as models,
               (select count(*)::integer from provider_health_events where provider_id = $1) as health_events,
               (select count(*)::integer from provider_health_summary where provider_id = $1) as health_summaries
      `,
      [providerId],
    );
    expect(counts.rows[0]).toEqual({ health_events: 0, health_summaries: 0, models: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("probe lifecycle readiness queues model_refresh only when credentials are ready", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_probe_queue_${randomUUID().replaceAll("-", "_")}`,
  });
  const localProviderId = randomUUID();
  const apiKeyProviderId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'ollama', 'Local', 'http://127.0.0.1:11434/v1', true),
               ($2, 'api_key', 'openai', 'Remote', 'https://api.openai.com/v1', true)
      `,
      [localProviderId, apiKeyProviderId],
    );

    await expect(
      enqueueProviderProbeLifecycleJob({
        databaseUrl: fixture.databaseUrl,
        providerId: apiKeyProviderId,
        source: "provider_created",
      }),
    ).resolves.toEqual({ queued: false, reason: "credential_missing" });
    const local = await enqueueProviderProbeLifecycleJob({
      databaseUrl: fixture.databaseUrl,
      providerId: localProviderId,
      source: "provider_created",
    });
    expect(local).toMatchObject({ queued: true });

    const jobs = await fixture.query<{ job_type: string; payload: Record<string, unknown> }>(
      "select job_type, payload from jobs order by created_at",
    );
    expect(jobs.rows).toEqual([
      {
        job_type: "model_refresh",
        payload: {
          followUpProbe: true,
          providerId: localProviderId,
          source: "provider_created",
        },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

async function readMutationCounts(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<{ configVersions: number; jobs: number; keys: number }> {
  const result = await fixture.query<{
    config_versions: number;
    jobs: number;
    keys: number;
  }>(`
    select (select count(*)::integer from provider_api_keys) as keys,
           (select count(*)::integer from config_versions) as config_versions,
           (select count(*)::integer from jobs) as jobs
  `);
  return {
    configVersions: result.rows[0]?.config_versions ?? -1,
    jobs: result.rows[0]?.jobs ?? -1,
    keys: result.rows[0]?.keys ?? -1,
  };
}
