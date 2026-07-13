import { randomUUID } from "node:crypto";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderConnectionProbesForProvider,
} from "@llmingress/db/provider-jobs";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("manual probing enqueues and deduplicates one exact connection job", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_probe_lifecycle_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'Probe Lifecycle', 'https://provider.test/v1', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, 'sk-probe', '{"version":1}'::jsonb, 'test-key')
      `,
      [providerConnectionId, providerId],
    );

    const first = await enqueueProviderConnectionProbeJob({
      databaseUrl: fixture.databaseUrl,
      providerConnectionId,
      providerId,
      source: "manual_probe",
      trigger: "manual",
    });
    const second = await enqueueProviderConnectionProbeJob({
      databaseUrl: fixture.databaseUrl,
      providerConnectionId,
      providerId,
      source: "manual_probe",
      trigger: "manual",
    });

    expect(first).toMatchObject({ queued: true, reused: false });
    expect(second).toMatchObject({ queued: true, reused: true });
    const jobs = await fixture.query<{
      job_type: string;
      payload: { providerConnectionId: string; providerId: string; source: string };
    }>("select job_type, payload from jobs");
    expect(jobs.rows).toEqual([
      {
        job_type: "provider_connection_probe",
        payload: {
          providerConnectionId,
          providerId,
          source: "manual_probe",
        },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("material connection changes enqueue a fresh probe while the stale probe is running", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_probe_replacement_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'Probe Replacement', 'https://provider.test/v1', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, 'sk-replace', '{"version":1}'::jsonb, 'test-key')
      `,
      [providerConnectionId, providerId],
    );

    const stale = await enqueueProviderConnectionProbeJob({
      databaseUrl: fixture.databaseUrl,
      providerConnectionId,
      providerId,
      source: "manual_probe",
      trigger: "manual",
    });
    expect(stale.queued).toBe(true);
    if (!stale.queued) {
      throw new Error("Expected the stale probe to be queued.");
    }
    await fixture.query("update jobs set status = 'running' where id = $1", [stale.jobId]);
    await fixture.query(
      `
        insert into provider_health_summary (id, provider_id, provider_connection_id, status)
        values ($1, $2, $3, 'unhealthy')
      `,
      [randomUUID(), providerId, providerConnectionId],
    );

    const replacement = await enqueueProviderConnectionProbeJob({
      databaseUrl: fixture.databaseUrl,
      providerConnectionId,
      providerId,
      resetHealth: true,
      source: "api_key_saved",
    });

    expect(replacement).toMatchObject({ queued: true, reused: false });
    const state = await fixture.query<{ pending: number; running: number; summaries: number }>(
      `
        select count(*) filter (where status = 'pending')::int as pending,
               count(*) filter (where status = 'running')::int as running,
               (select count(*)::int from provider_health_summary) as summaries
        from jobs
        where job_type = 'provider_connection_probe'
      `,
    );
    expect(state.rows[0]).toEqual({ pending: 1, running: 1, summaries: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("Provider fanout creates independent connection jobs and Local uses its logical id", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_probe_fanout_${randomUUID().replaceAll("-", "_")}`,
  });
  const apiProviderId = randomUUID();
  const localProviderId = randomUUID();
  const connectionIds = [randomUUID(), randomUUID()];
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'API Provider', 'https://provider.test/v1', true),
               ($2, 'local', 'llama_cpp', 'Local Provider', 'http://127.0.0.1:8080/v1', true)
      `,
      [apiProviderId, localProviderId],
    );
    for (const [index, connectionId] of connectionIds.entries()) {
      await fixture.query(
        `
          insert into provider_api_keys (
            id, provider_id, key_prefix, encrypted_key, key_id, priority
          )
          values ($1, $2, $3, '{"version":1}'::jsonb, 'test-key', $4)
        `,
        [connectionId, apiProviderId, `key-${index}`, index],
      );
    }

    await enqueueProviderConnectionProbesForProvider({
      databaseUrl: fixture.databaseUrl,
      providerId: apiProviderId,
      source: "base_url_changed",
    });
    await enqueueProviderConnectionProbesForProvider({
      databaseUrl: fixture.databaseUrl,
      providerId: localProviderId,
      source: "provider_enabled",
    });

    const jobs = await fixture.query<{ provider_connection_id: string; provider_id: string }>(
      `
        select payload ->> 'providerConnectionId' as provider_connection_id,
               payload ->> 'providerId' as provider_id
        from jobs
        order by provider_id, provider_connection_id
      `,
    );
    expect(jobs.rows).toEqual(
      [
        ...connectionIds.map((providerConnectionId) => ({
          provider_connection_id: providerConnectionId,
          provider_id: apiProviderId,
        })),
        {
          provider_connection_id: localProviderId,
          provider_id: localProviderId,
        },
      ].sort((left, right) =>
        `${left.provider_id}:${left.provider_connection_id}`.localeCompare(
          `${right.provider_id}:${right.provider_connection_id}`,
        ),
      ),
    );
  } finally {
    await fixture.dispose();
  }
});
