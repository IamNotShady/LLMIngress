import { randomUUID } from "node:crypto";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import { deleteProvider } from "@llmingress/db/console-providers";
import { deleteProviderOAuthConnection } from "@llmingress/db/providers";
import { gatewayBackgroundTasks } from "@llmingress/gateway-runtime/gateway-background-tasks";
import { attachGatewayProviderCredentials } from "@llmingress/gateway-runtime/gateway-provider-credentials";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { createPostgresJobRunner } from "@llmingress/worker-runtime/worker-job-runner";
import { createProviderConnectionProbeJobHandler } from "@llmingress/worker-runtime/worker-provider-connection-probe";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

const masterKeySource = { kind: "inline", value: "provider-connection-health-test-key" } as const;

test("OAuth soft deletes clear encrypted credentials and pending authorization state", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_oauth_delete_secret_${randomUUID().replaceAll("-", "_")}`,
  });
  const directProviderId = randomUUID();
  const directConnectionId = randomUUID();
  const providerDeleteId = randomUUID();
  const providerDeleteConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url)
        values
          ($1, 'subscription', 'openai_codex', 'Direct OAuth Delete', 'https://direct.test/v1'),
          ($2, 'subscription', 'claude_code', 'Provider OAuth Delete', 'https://provider.test/v1')
      `,
      [directProviderId, providerDeleteId],
    );
    for (const [connectionId, providerId] of [
      [directConnectionId, directProviderId],
      [providerDeleteConnectionId, providerDeleteId],
    ]) {
      await fixture.query(
        `
          insert into provider_oauth (
            id, provider_id, pending_state, pending_code_verifier,
            pending_code_challenge, pending_expires_at, encrypted_token,
            token_expires_at, completed_at
          )
          values (
            $1, $2, $3, 'oauth-verifier', 'oauth-challenge',
            now() + interval '10 minutes', '{"ciphertext":"secret"}'::jsonb,
            now() + interval '1 hour', now()
          )
        `,
        [connectionId, providerId, `oauth-state-${connectionId}`],
      );
    }

    await deleteProviderOAuthConnection({
      databaseUrl: fixture.databaseUrl,
      providerOAuthId: directConnectionId,
    });

    const afterDirectDelete = await readOAuthDeletionState(fixture, [
      directConnectionId,
      providerDeleteConnectionId,
    ]);
    expect(afterDirectDelete.get(directConnectionId)).toEqual(clearedOAuthDeletionState);
    expect(afterDirectDelete.get(providerDeleteConnectionId)).toMatchObject({
      deleted: false,
      enabled: true,
      encrypted_token: { ciphertext: "secret" },
    });

    await deleteProvider({ databaseUrl: fixture.databaseUrl, id: providerDeleteId });

    const afterProviderDelete = await readOAuthDeletionState(fixture, [providerDeleteConnectionId]);
    expect(afterProviderDelete.get(providerDeleteConnectionId)).toEqual(clearedOAuthDeletionState);
  } finally {
    await fixture.dispose();
  }
});

test("connection probe succeeds when the third distinct model succeeds", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_probe_success_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const attemptedModels: string[] = [];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedLocalProviderWithModels(fixture, providerId);
    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        attemptedModels.push(body.model);
        if (body.model !== "model-c") {
          return Response.json({ error: { message: "probe failed" } }, { status: 503 });
        }
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      },
      masterKeySource,
    });

    await handler(probeJob({ providerConnectionId: providerId, providerId }));

    expect(attemptedModels).toEqual(["model-a", "model-b", "model-c"]);
    const health = await fixture.query<{
      events: number;
      metadata: { modelAttempts: Array<{ modelId: string; ok: boolean }> };
      status: string;
      summaries: number;
    }>(
      `
        select (select count(*)::integer from provider_health_summary) as summaries,
               (select count(*)::integer from provider_health_events) as events,
               status,
               metadata
        from provider_health_events
        limit 1
      `,
    );
    expect(health.rows[0]).toMatchObject({ events: 1, status: "healthy", summaries: 0 });
    expect(health.rows[0]?.metadata.modelAttempts).toMatchObject([
      { modelId: "model-a", ok: false },
      { modelId: "model-b", ok: false },
      { modelId: "model-c", ok: true },
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("connection probe stores one unhealthy summary and schedules a five minute retry", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_probe_failure_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedLocalProviderWithModels(fixture, providerId);
    const before = Date.now();
    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async () =>
        Response.json({ error: { message: "provider unavailable" } }, { status: 503 }),
      masterKeySource,
    });

    await handler(probeJob({ providerConnectionId: providerId, providerId }));

    const state = await fixture.query<{
      consecutive_failures: number;
      error_message: string;
      job_type: string;
      provider_connection_id: string;
      run_after: Date;
    }>(
      `
        select summary.provider_connection_id::text,
               summary.consecutive_failures,
               summary.reason_message as error_message,
               jobs.job_type,
               jobs.run_after
        from provider_health_summary as summary
        join jobs
          on jobs.payload ->> 'providerConnectionId' = summary.provider_connection_id::text
        where jobs.status = 'pending'
      `,
    );
    expect(state.rows[0]).toMatchObject({
      consecutive_failures: 1,
      job_type: "provider_connection_probe",
      provider_connection_id: providerId,
    });
    expect(state.rows[0]?.error_message).toContain("provider unavailable");
    expect(state.rows[0]?.run_after.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000 - 2_000);
    expect(state.rows[0]?.run_after.getTime()).toBeLessThanOrEqual(before + 5 * 60_000 + 2_000);
    const [consoleHealth] = await listConsoleProviderHealthSummaries({
      databaseUrl: fixture.databaseUrl,
    });
    expect(consoleHealth).toMatchObject({
      nextProbeAt: state.rows[0]?.run_after,
      status: "unhealthy",
    });
  } finally {
    await fixture.dispose();
  }
});

test("a second consecutive failure advances the retry schedule to ten minutes", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_probe_backoff_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedLocalProviderWithModels(fixture, providerId);
    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async () =>
        Response.json({ error: { message: "still unavailable" } }, { status: 503 }),
      masterKeySource,
    });

    await handler(probeJob({ providerConnectionId: providerId, providerId }));
    const firstRetry = await fixture.query<{ id: string }>(
      `
        select id::text
        from jobs
        where job_type = 'provider_connection_probe'
          and status = 'pending'
        limit 1
      `,
    );
    const retryJobId = firstRetry.rows[0]?.id;
    expect(retryJobId).toBeTruthy();
    await fixture.query("update jobs set status = 'running' where id = $1", [retryJobId]);

    const before = Date.now();
    await handler(
      probeJob({
        id: retryJobId,
        providerConnectionId: providerId,
        providerId,
        source: "scheduled_probe",
        trigger: "scheduled",
      }),
    );

    const state = await fixture.query<{
      consecutive_failures: number;
      run_after: Date;
    }>(
      `
        select summary.consecutive_failures, jobs.run_after
        from provider_health_summary as summary
        join jobs
          on jobs.payload ->> 'providerConnectionId' = summary.provider_connection_id::text
        where jobs.status = 'pending'
      `,
    );
    expect(state.rows[0]?.consecutive_failures).toBe(2);
    expect(state.rows[0]?.run_after.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000 - 2_000);
    expect(state.rows[0]?.run_after.getTime()).toBeLessThanOrEqual(before + 10 * 60_000 + 2_000);
  } finally {
    await fixture.dispose();
  }
});

test("a successful probe deletes the sparse summary and cancels its pending retry", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_probe_recovery_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  let healthy = false;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedLocalProviderWithModels(fixture, providerId);
    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async () =>
        healthy
          ? Response.json({ choices: [{ message: { content: "pong" } }] })
          : Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 }),
      masterKeySource,
    });

    await handler(probeJob({ providerConnectionId: providerId, providerId }));
    healthy = true;
    await handler(probeJob({ providerConnectionId: providerId, providerId }));

    const state = await fixture.query<{
      canceled_jobs: number;
      healthy_events: number;
      pending_jobs: number;
      summaries: number;
    }>(
      `
        select (select count(*)::integer from provider_health_summary) as summaries,
               (
                 select count(*)::integer
                 from provider_health_events
                 where status = 'healthy'
               ) as healthy_events,
               (
                 select count(*)::integer
                 from jobs
                 where job_type = 'provider_connection_probe'
                   and status = 'pending'
               ) as pending_jobs,
               (
                 select count(*)::integer
                 from jobs
                 where job_type = 'provider_connection_probe'
                   and status = 'canceled'
               ) as canceled_jobs
      `,
    );
    expect(state.rows[0]).toEqual({
      canceled_jobs: 1,
      healthy_events: 1,
      pending_jobs: 0,
      summaries: 0,
    });
  } finally {
    await fixture.dispose();
  }
});

test("a probe whose Provider snapshot changes does not commit health or retry state", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_probe_stale_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  let changed = false;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedLocalProviderWithModels(fixture, providerId);
    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async () => {
        if (!changed) {
          changed = true;
          await fixture.query(
            "update providers set base_url = 'http://replacement.test/v1', updated_at = now() where id = $1",
            [providerId],
          );
        }
        return Response.json({ error: { message: "old endpoint failed" } }, { status: 503 });
      },
      masterKeySource,
    });

    const result = await handler(probeJob({ providerConnectionId: providerId, providerId }));
    expect(result).toMatchObject({
      canceled: true,
      reason: "provider_connection_probe_snapshot_stale",
    });
    const state = await fixture.query<{
      events: number;
      jobs: number;
      summaries: number;
    }>(
      `
        select (select count(*)::integer from provider_health_events) as events,
               (select count(*)::integer from provider_health_summary) as summaries,
               (select count(*)::integer from jobs) as jobs
      `,
    );
    expect(state.rows[0]).toEqual({ events: 0, jobs: 0, summaries: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("Worker persists a canceled job when its Provider is disabled", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_probe_canceled_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const jobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (
          id, provider_type, provider_key, display_name, base_url, enabled
        )
        values ($1, 'local', 'openai', 'Disabled Probe', 'http://provider.test/v1', false)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into jobs (
          id, job_type, status, trigger, payload, max_attempts, run_after
        )
        values (
          $1, 'provider_connection_probe', 'pending', 'scheduled', $2::jsonb, 3,
          now() - interval '1 second'
        )
      `,
      [
        jobId,
        JSON.stringify({
          providerConnectionId: providerId,
          providerId,
          source: "scheduled_probe",
        }),
      ],
    );
    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        provider_connection_probe: createProviderConnectionProbeJobHandler({
          databaseUrl: fixture.databaseUrl,
          fetch: async () => {
            throw new Error("A canceled probe must not call the Provider.");
          },
          masterKeySource,
        }),
      },
      workerId: "provider-connection-canceled-test",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    const state = await fixture.query<{
      attempt_result: { canceled: boolean; reason: string };
      attempt_status: string;
      events: number;
      job_result: { canceled: boolean; reason: string };
      job_status: string;
      pending_jobs: number;
      summaries: number;
    }>(
      `
        select jobs.status as job_status,
               jobs.result as job_result,
               job_attempts.status as attempt_status,
               job_attempts.result as attempt_result,
               (select count(*)::int from provider_health_events) as events,
               (select count(*)::int from provider_health_summary) as summaries,
               (
                 select count(*)::int
                 from jobs as pending
                 where pending.job_type = 'provider_connection_probe'
                   and pending.status = 'pending'
               ) as pending_jobs
        from jobs
        join job_attempts on job_attempts.job_id = jobs.id
        where jobs.id = $1
      `,
      [jobId],
    );
    expect(state.rows[0]).toEqual({
      attempt_result: { canceled: true, reason: "provider_disabled_or_missing" },
      attempt_status: "succeeded",
      events: 0,
      job_result: { canceled: true, reason: "provider_disabled_or_missing" },
      job_status: "canceled",
      pending_jobs: 0,
      summaries: 0,
    });
  } finally {
    await fixture.dispose();
  }
});

test("Console sidebar counts aggregate Provider health", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_health_sidebar_${randomUUID().replaceAll("-", "_")}`,
  });
  const mixedProviderId = randomUUID();
  const failedProviderId = randomUUID();
  const mixedHealthyConnectionId = randomUUID();
  const mixedUnhealthyConnectionId = randomUUID();
  const failedConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (
          id, provider_type, provider_key, display_name, base_url, enabled
        )
        values
          ($1, 'api_key', 'openai', 'Mixed Provider', 'https://mixed.test/v1', true),
          ($2, 'api_key', 'anthropic', 'Failed Provider', 'https://failed.test/v1', true)
      `,
      [mixedProviderId, failedProviderId],
    );
    for (const [id, providerId, prefix] of [
      [mixedHealthyConnectionId, mixedProviderId, "mixed-ok"],
      [mixedUnhealthyConnectionId, mixedProviderId, "mixed-bad"],
      [failedConnectionId, failedProviderId, "failed"],
    ]) {
      await fixture.query(
        `
          insert into provider_api_keys (
            id, provider_id, key_prefix, encrypted_key, key_id
          )
          values ($1, $2, $3, '{}'::jsonb, 'test-key')
        `,
        [id, providerId, prefix],
      );
    }
    for (const [providerId, providerConnectionId] of [
      [mixedProviderId, mixedUnhealthyConnectionId],
      [failedProviderId, failedConnectionId],
    ]) {
      await fixture.query(
        `
          insert into provider_health_summary (
            id, provider_id, provider_connection_id, reason_code, reason_message
          )
          values ($1, $2, $3, 'invalid_api_key', 'Invalid API key')
        `,
        [randomUUID(), providerId, providerConnectionId],
      );
    }

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });
    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);
        await expect(page.getByRole("img", { name: "1 healthy providers" })).toBeVisible();
        await expect(page.getByRole("img", { name: "1 unhealthy providers" })).toBeVisible();
        await expect(page.getByRole("img", { name: "2 unhealthy providers" })).toHaveCount(0);
      } finally {
        await context.close();
      }
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await fixture.dispose();
  }
});

test("an OAuth probe cannot overwrite a token rotated while refresh is in flight", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_oauth_probe_stale_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const encryption = createSecretEncryption(masterKeySource);
  const expired = encryption.encrypt(
    JSON.stringify({
      accessToken: "expired-token",
      expiresAt: Date.now() - 60_000,
      refreshToken: "refresh-token",
      scopes: [],
      tokenType: "Bearer",
    }),
  );
  const rotated = encryption.encrypt(
    JSON.stringify({
      accessToken: "rotated-token",
      expiresAt: null,
      refreshToken: "rotated-refresh-token",
      scopes: [],
      tokenType: "Bearer",
    }),
  );

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'subscription', 'openai_codex', 'OAuth Probe', 'https://provider.test/v1', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_oauth (
          id, provider_id, encrypted_token, token_expires_at, completed_at
        )
        values ($1, $2, $3, now() - interval '1 minute', now())
      `,
      [providerConnectionId, providerId, JSON.stringify(expired)],
    );

    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async (url) => {
        if (String(url).startsWith("https://auth.openai.com/")) {
          await fixture.query(
            "update provider_oauth set encrypted_token = $2::jsonb, updated_at = now() where id = $1",
            [providerConnectionId, JSON.stringify(rotated)],
          );
          return Response.json({
            access_token: "refreshed-token",
            expires_in: 3600,
            refresh_token: "refresh-token",
            token_type: "Bearer",
          });
        }
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      },
      masterKeySource,
    });

    const result = await handler(probeJob({ providerConnectionId, providerId }));
    expect(result).toMatchObject({
      canceled: true,
      reason: "provider_connection_changed_during_oauth_refresh",
    });
    const state = await fixture.query<{
      encrypted_token: unknown;
      events: number;
      jobs: number;
      summaries: number;
    }>(
      `
        select encrypted_token,
               (select count(*)::int from provider_health_events) as events,
               (select count(*)::int from provider_health_summary) as summaries,
               (select count(*)::int from jobs) as jobs
        from provider_oauth
        where id = $1
      `,
      [providerConnectionId],
    );
    expect(state.rows[0]).toEqual({
      encrypted_token: rotated,
      events: 0,
      jobs: 0,
      summaries: 0,
    });
  } finally {
    await fixture.dispose();
  }
});

test("Gateway excludes only unhealthy provider connections", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_filter_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const unhealthyConnectionId = randomUUID();
  const healthyConnectionId = randomUUID();
  const subscriptionProviderId = randomUUID();
  const healthyOAuthConnectionId = randomUUID();
  const encryption = createSecretEncryption(masterKeySource);

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'Connection Filter', 'https://provider.test/v1', true)
      `,
      [providerId],
    );
    for (const [id, plaintext, priority] of [
      [unhealthyConnectionId, "unhealthy-secret", 1],
      [healthyConnectionId, "healthy-secret", 2],
    ] as const) {
      const encrypted = encryption.encrypt(plaintext);
      await fixture.query(
        `
          insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, priority)
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          id,
          providerId,
          plaintext.slice(0, 8),
          JSON.stringify(encrypted),
          encrypted.keyId,
          priority,
        ],
      );
    }
    await fixture.query(
      `
        insert into provider_health_summary (
          id, provider_id, provider_connection_id, last_event_id,
          consecutive_failures, last_failure_at, reason_code, reason_message, next_probe_at
        )
        values ($1, $2, $3, null, 1, now(), 'auth_failed', 'invalid key', now() + interval '5 minutes')
      `,
      [randomUUID(), providerId, unhealthyConnectionId],
    );
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'subscription', 'openai_codex', 'Connection Collision', 'https://subscription.test/v1', true)
      `,
      [subscriptionProviderId],
    );
    for (const id of [healthyConnectionId, healthyOAuthConnectionId]) {
      const encrypted = encryption.encrypt(
        JSON.stringify({
          accessToken: `oauth-${id}`,
          expiresAt: null,
          refreshToken: null,
          scopes: [],
          tokenType: "Bearer",
        }),
      );
      await fixture.query(
        `
          insert into provider_oauth (id, provider_id, encrypted_token, completed_at)
          values ($1, $2, $3, now())
        `,
        [id, subscriptionProviderId, JSON.stringify(encrypted)],
      );
    }
    await fixture.query(
      `
        insert into provider_health_summary (
          id, provider_id, provider_connection_id, last_event_id,
          consecutive_failures, last_failure_at, reason_code, reason_message, next_probe_at
        )
        values ($1, $2, $3, null, 1, now(), 'auth_failed', 'invalid token', now() + interval '5 minutes')
      `,
      [randomUUID(), subscriptionProviderId, healthyConnectionId],
    );

    const [candidate, subscriptionCandidate] = await attachGatewayProviderCredentials({
      candidates: [
        {
          candidateOrder: 1,
          displayName: "Fake Model",
          modelId: "fake-model",
          price: {
            modelId: "fake-model",
            priceVersion: "test",
            providerKey: "openai",
            reason: "no_current_price",
            status: "unknown_price",
          },
          providerId,
          providerKey: "openai",
          providerModelId,
        },
        {
          candidateOrder: 2,
          displayName: "Subscription Model",
          modelId: "subscription-model",
          price: {
            modelId: "subscription-model",
            priceVersion: "test",
            providerKey: "openai_codex",
            reason: "no_current_price",
            status: "unknown_price",
          },
          providerId: subscriptionProviderId,
          providerKey: "openai_codex",
          providerModelId: randomUUID(),
        },
      ],
      databaseUrl: fixture.databaseUrl,
      masterKeySource,
    });

    expect(candidate?.providerApiKeys).toHaveLength(1);
    expect(candidate?.providerApiKeys?.[0]).toMatchObject({
      apiKey: "healthy-secret",
      providerConnectionId: healthyConnectionId,
    });
    expect(subscriptionCandidate?.providerApiKeys).toHaveLength(1);
    expect(subscriptionCandidate?.providerApiKeys?.[0]).toMatchObject({
      apiKey: `oauth-${healthyOAuthConnectionId}`,
      providerConnectionId: healthyOAuthConnectionId,
    });
  } finally {
    await fixture.dispose();
  }
});

test("Gateway credential-load failures enqueue the exact connection probe", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_load_failure_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'Broken Credential', 'https://provider.test/v1', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, 'broken', '{}'::jsonb, 'missing-key')
      `,
      [providerConnectionId, providerId],
    );

    await expect(
      attachGatewayProviderCredentials({
        candidates: [
          {
            candidateOrder: 1,
            displayName: "Fake Model",
            modelId: "fake-model",
            price: {
              modelId: "fake-model",
              priceVersion: "test",
              providerKey: "openai",
              reason: "no_current_price",
              status: "unknown_price",
            },
            providerId,
            providerKey: "openai",
            providerModelId: randomUUID(),
          },
        ],
        databaseUrl: fixture.databaseUrl,
        masterKeySource,
      }),
    ).rejects.toMatchObject({ code: "provider_connection_unavailable" });
    await gatewayBackgroundTasks.drain({ timeoutMs: 1_000 });

    const jobs = await fixture.query<{
      id: string;
      provider_connection_id: string;
      provider_id: string;
      source: string;
    }>(
      `
        select id::text,
               payload ->> 'providerId' as provider_id,
               payload ->> 'providerConnectionId' as provider_connection_id,
               payload ->> 'source' as source
        from jobs
        where job_type = 'provider_connection_probe'
      `,
    );
    expect(jobs.rows).toMatchObject([
      {
        provider_connection_id: providerConnectionId,
        provider_id: providerId,
        source: "gateway_credential_error",
      },
    ]);
    const jobId = jobs.rows[0]?.id;
    expect(jobId).toBeTruthy();
    await fixture.query("update jobs set status = 'running' where id = $1", [jobId]);
    const handler = createProviderConnectionProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async () => {
        throw new Error("credential preflight must fail before Provider egress");
      },
      masterKeySource,
    });
    await handler(
      probeJob({
        id: jobId,
        providerConnectionId,
        providerId,
        source: "gateway_credential_error",
        trigger: "system",
      }),
    );
    const summary = await fixture.query<{
      provider_connection_id: string;
      reason_code: string;
      status: string;
    }>(
      `
        select provider_connection_id::text, reason_code, status
        from provider_health_summary
      `,
    );
    expect(summary.rows).toEqual([
      {
        provider_connection_id: providerConnectionId,
        reason_code: "provider_connection_credential_unavailable",
        status: "unhealthy",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

function probeJob(input: {
  id?: string;
  providerConnectionId: string;
  providerId: string;
  source?: "gateway_credential_error" | "manual_probe" | "scheduled_probe";
  trigger?: "manual" | "scheduled" | "system";
}) {
  return {
    attemptNumber: 1,
    id: input.id ?? randomUUID(),
    jobType: "provider_connection_probe",
    maxAttempts: 3,
    payload: {
      providerConnectionId: input.providerConnectionId,
      providerId: input.providerId,
      source: input.source ?? "manual_probe",
    },
    priority: 0,
    signal: new AbortController().signal,
    trigger: input.trigger ?? "manual",
    workerId: "provider-connection-health-test",
  };
}

async function seedLocalProviderWithModels(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  providerId: string,
): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'local', 'openai', 'Local Probe', 'http://provider.test/v1', true)
    `,
    [providerId],
  );
  for (const modelId of ["model-a", "model-b", "model-c", "model-d"]) {
    await fixture.query(
      `
        insert into provider_models (
          id, provider_id, model_id, display_name, context_window,
          supports_streaming, availability
        )
        values ($1, $2, $3, $3, 4096, true, 'available')
      `,
      [randomUUID(), providerId, modelId],
    );
  }
}

type OAuthDeletionState = {
  completed_at: Date | null;
  deleted: boolean;
  enabled: boolean;
  encrypted_token: unknown;
  pending_code_challenge: string | null;
  pending_code_verifier: string | null;
  pending_expires_at: Date | null;
  pending_state: string | null;
  token_expires_at: Date | null;
};

const clearedOAuthDeletionState: OAuthDeletionState = {
  completed_at: null,
  deleted: true,
  enabled: false,
  encrypted_token: null,
  pending_code_challenge: null,
  pending_code_verifier: null,
  pending_expires_at: null,
  pending_state: null,
  token_expires_at: null,
};

async function readOAuthDeletionState(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  connectionIds: string[],
): Promise<Map<string, OAuthDeletionState>> {
  const result = await fixture.query<OAuthDeletionState & { id: string }>(
    `
      select id::text,
             enabled,
             encrypted_token,
             token_expires_at,
             pending_state,
             pending_code_verifier,
             pending_code_challenge,
             pending_expires_at,
             completed_at,
             deleted_at is not null as deleted
      from provider_oauth
      where id = any($1::uuid[])
    `,
    [connectionIds],
  );
  return new Map(result.rows.map(({ id, ...state }) => [id, state]));
}
