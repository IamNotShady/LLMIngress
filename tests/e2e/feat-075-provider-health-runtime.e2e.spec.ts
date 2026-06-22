import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import {
  createPeriodicScheduler,
  type PeriodicTaskDefinition,
} from "../../apps/worker/src/periodic-scheduler";
import { createProviderConnectivityCheckJobHandler } from "../../apps/worker/src/provider-connectivity-check";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { HEALTH_SUMMARY_CHANGED_CHANNEL } from "../../packages/db/src/provider-health";
import type { MasterKeySource } from "../../packages/security/src/master-key";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-provider-health-075";
const agentApiKey = "llmi_provider_health_gateway_key_075";

test("provider health summary updates notifications and scheduled checks without changing route selection", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_health_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const masterKeySource = {
    kind: "inline",
    value: masterKey,
  } satisfies MasterKeySource;
  const notifications = await listenForHealthNotifications(fixture.databaseUrl);

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedProviderHealthScenario(fixture, {
      manualBaseUrl: `${provider.url}/v1`,
      requestFallbackBaseUrl: `${provider.url}/v1`,
      requestPrimaryBaseUrl: `${provider.url}/v1?mode=first-byte-failure`,
      scheduledBaseUrl: `${provider.url}/v1?mode=error`,
    });

    await runConnectivityJob(fixture, masterKeySource, {
      providerId: seeded.manualProviderId,
      trigger: "manual",
    });
    await expect(readProviderSummary(fixture, seeded.manualProviderId, null)).resolves.toEqual({
      consecutive_failures: 0,
      status: "healthy",
    });
    await expect(readHealthEvents(fixture, seeded.manualProviderId)).resolves.toEqual([
      expect.objectContaining({
        error_code: null,
        status: "healthy",
        trigger: "manual",
      }),
    ]);

    const scheduler = createPeriodicScheduler({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      store: {
        enqueueScheduledJob: async (input) => {
          await fixture.query(
            `
              insert into jobs (
                id,
                job_type,
                status,
                trigger,
                priority,
                payload,
                run_after,
                max_attempts
              )
              values ($1, $2, 'pending', 'scheduled', $3, $4::jsonb, $5::timestamptz, $6)
            `,
            [
              randomUUID(),
              input.jobType,
              input.priority,
              JSON.stringify(input.payload),
              input.runAfter.toISOString(),
              input.maxAttempts,
            ],
          );
          return { created: true, jobId: "scheduled-provider-health-job" };
        },
      },
      tasks: [
        {
          id: "scheduled-provider-health",
          intervalMs: 60_000,
          jobType: "provider_connectivity_check",
          maxAttempts: 1,
          payload: { providerId: seeded.scheduledProviderId },
          priority: 0,
          startAt: new Date("2026-01-01T00:00:00.000Z"),
        } satisfies PeriodicTaskDefinition,
      ],
    });
    await expect(scheduler.runOnce()).resolves.toMatchObject({ createdJobs: 1 });
    await runPendingConnectivityJob(fixture, masterKeySource);
    await expect(readProviderSummary(fixture, seeded.scheduledProviderId, null)).resolves.toEqual({
      consecutive_failures: 1,
      status: "unhealthy",
    });
    await expect(readHealthEvents(fixture, seeded.scheduledProviderId)).resolves.toEqual([
      expect.objectContaining({
        error_code: "fake_provider_error",
        status: "unhealthy",
        trigger: "worker_probe",
      }),
    ]);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ content: "health runtime should still try primary", role: "user" }],
          model: "health-routing",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_provider_health_075",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(provider.requests.map((request) => request.bodyJson)).toEqual([
        expect.objectContaining({ model: "manual-health-model" }),
        expect.objectContaining({ model: "scheduled-health-model" }),
        expect.objectContaining({ model: "primary-health-model" }),
        expect.objectContaining({ model: "fallback-health-model" }),
      ]);
      await expect(
        readProviderSummary(fixture, seeded.requestPrimaryProviderId, null),
      ).resolves.toEqual({
        consecutive_failures: 3,
        status: "network_error",
      });
      await expect(
        readProviderSummary(fixture, seeded.requestPrimaryProviderId, seeded.requestPrimaryModelId),
      ).resolves.toEqual({
        consecutive_failures: 3,
        status: "network_error",
      });
      await expect(readRequestActivity(fixture, "req_provider_health_075")).resolves.toEqual({
        provider_model_id: seeded.requestFallbackModelId,
        status: "succeeded",
      });
      const requestHealthEvents = await readHealthEvents(fixture, seeded.requestPrimaryProviderId);
      expect(requestHealthEvents).toHaveLength(4);
      expect(requestHealthEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: "seeded_unhealthy",
            provider_model_id: null,
            status: "unhealthy",
            trigger: "request_path",
          }),
          expect.objectContaining({
            error_code: "seeded_unhealthy",
            provider_model_id: seeded.requestPrimaryModelId,
            status: "unhealthy",
            trigger: "request_path",
          }),
          expect.objectContaining({
            error_code: "provider_request_failed",
            provider_model_id: null,
            status: "network_error",
            trigger: "request_path",
          }),
          expect.objectContaining({
            error_code: "provider_request_failed",
            provider_model_id: seeded.requestPrimaryModelId,
            status: "network_error",
            trigger: "request_path",
          }),
        ]),
      );
    } finally {
      await stopGatewayProcess(gateway);
    }

    await expect
      .poll(() => notifications.payloads.length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(4);
    expect(notifications.payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: seeded.manualProviderId, status: "healthy" }),
        expect.objectContaining({ providerId: seeded.scheduledProviderId, status: "unhealthy" }),
        expect.objectContaining({
          providerId: seeded.requestPrimaryProviderId,
          providerModelId: null,
          status: "network_error",
        }),
        expect.objectContaining({
          providerId: seeded.requestPrimaryProviderId,
          providerModelId: seeded.requestPrimaryModelId,
          status: "network_error",
        }),
      ]),
    );
  } finally {
    await notifications.close();
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type HealthNotificationListener = {
  close: () => Promise<void>;
  payloads: Array<Record<string, unknown>>;
};

type ProviderSummaryRow = {
  consecutive_failures: number;
  status: string;
};

type HealthEventRow = {
  error_code: string | null;
  provider_model_id: string | null;
  status: string;
  trigger: string;
};

type RequestActivityRow = {
  provider_model_id: string | null;
  status: string;
};

type SeededProviderHealthScenario = {
  manualModelId: string;
  manualProviderId: string;
  requestFallbackModelId: string;
  requestPrimaryModelId: string;
  requestPrimaryProviderId: string;
  scheduledModelId: string;
  scheduledProviderId: string;
};

async function seedProviderHealthScenario(
  fixture: Fixture,
  input: {
    manualBaseUrl: string;
    requestFallbackBaseUrl: string;
    requestPrimaryBaseUrl: string;
    scheduledBaseUrl: string;
  },
): Promise<SeededProviderHealthScenario> {
  const encryption = createSecretEncryption({ kind: "inline", value: masterKey });
  const manualProviderId = randomUUID();
  const manualModelId = randomUUID();
  const scheduledProviderId = randomUUID();
  const scheduledModelId = randomUUID();
  const requestPrimaryProviderId = randomUUID();
  const requestFallbackProviderId = randomUUID();
  const requestPrimaryModelId = randomUUID();
  const requestFallbackModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'health-manual', 'Health Manual', $2, true),
             ($3, 'api_key', 'health-scheduled', 'Health Scheduled', $4, true),
             ($5, 'api_key', 'health-request-primary', 'Health Request Primary', $6, true),
             ($7, 'api_key', 'health-request-fallback', 'Health Request Fallback', $8, true)
    `,
    [
      manualProviderId,
      input.manualBaseUrl,
      scheduledProviderId,
      input.scheduledBaseUrl,
      requestPrimaryProviderId,
      input.requestPrimaryBaseUrl,
      requestFallbackProviderId,
      input.requestFallbackBaseUrl,
    ],
  );
  for (const providerId of [
    manualProviderId,
    scheduledProviderId,
    requestPrimaryProviderId,
    requestFallbackProviderId,
  ]) {
    const encrypted = encryption.encrypt(providerApiKey);
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, $3, $4, $5)
      `,
      [
        randomUUID(),
        providerId,
        providerApiKey.slice(0, 8),
        JSON.stringify(encrypted),
        encrypted.keyId,
      ],
    );
  }
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        context_window,
        supports_streaming,
        supports_tools,
        availability
      )
      values ($1, $2, 'manual-health-model', 'Manual Health Model', 128000, true, true, 'available'),
             ($3, $4, 'scheduled-health-model', 'Scheduled Health Model', 128000, true, true, 'available'),
             ($5, $6, 'primary-health-model', 'Primary Health Model', 128000, true, true, 'available'),
             ($7, $8, 'fallback-health-model', 'Fallback Health Model', 128000, true, true, 'available')
    `,
    [
      manualModelId,
      manualProviderId,
      scheduledModelId,
      scheduledProviderId,
      requestPrimaryModelId,
      requestPrimaryProviderId,
      requestFallbackModelId,
      requestFallbackProviderId,
    ],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'health-routing', 'Health Routing', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed')
    `,
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order,
        is_fallback
      )
      values ($1, $2, $3, 1, false),
             ($4, $2, $5, 2, true)
    `,
    [randomUUID(), routePolicyId, requestPrimaryModelId, randomUUID(), requestFallbackModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Health Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(agentApiKey),
      virtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Provider health config')",
  );
  await seedUnhealthyRequestSummary(fixture, {
    providerId: requestPrimaryProviderId,
    providerModelId: null,
  });
  await seedUnhealthyRequestSummary(fixture, {
    providerId: requestPrimaryProviderId,
    providerModelId: requestPrimaryModelId,
  });

  return {
    manualModelId,
    manualProviderId,
    requestFallbackModelId,
    requestPrimaryModelId,
    requestPrimaryProviderId,
    scheduledModelId,
    scheduledProviderId,
  };
}

async function seedUnhealthyRequestSummary(
  fixture: Fixture,
  input: { providerId: string; providerModelId: string | null },
): Promise<void> {
  const eventId = randomUUID();
  await fixture.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        trigger,
        status,
        error_code,
        error_message,
        observed_at
      )
      values ($1, $2, $3, 'request_path', 'unhealthy', 'seeded_unhealthy', 'Seeded unhealthy state', '2026-06-16T04:59:00.000Z')
    `,
    [eventId, input.providerId, input.providerModelId],
  );
  await fixture.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        last_event_id,
        status,
        consecutive_failures,
        last_failure_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'unhealthy', 2, '2026-06-16T04:59:00.000Z', '2026-06-16T04:59:00.000Z')
    `,
    [randomUUID(), input.providerId, input.providerModelId, eventId],
  );
}

async function runConnectivityJob(
  fixture: Fixture,
  masterKeySource: MasterKeySource,
  input: { providerId: string; trigger: "manual" | "scheduled" },
): Promise<void> {
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      provider_connectivity_check: createProviderConnectivityCheckJobHandler({
        databaseUrl: fixture.databaseUrl,
        masterKeySource,
      }),
    },
    workerId: `worker-provider-health-${randomUUID()}`,
  });
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'provider_connectivity_check', 'pending', $2, $3::jsonb, 1)
    `,
    [randomUUID(), input.trigger, JSON.stringify({ providerId: input.providerId })],
  );

  await expect(runner.runOnce()).resolves.toBe(true);
}

async function runPendingConnectivityJob(
  fixture: Fixture,
  masterKeySource: MasterKeySource,
): Promise<void> {
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      provider_connectivity_check: createProviderConnectivityCheckJobHandler({
        databaseUrl: fixture.databaseUrl,
        masterKeySource,
      }),
    },
    workerId: `worker-provider-health-${randomUUID()}`,
  });
  await expect(runner.runOnce()).resolves.toBe(true);
}

async function readProviderSummary(
  fixture: Fixture,
  providerId: string,
  providerModelId: string | null,
): Promise<ProviderSummaryRow | null> {
  const result = await fixture.query<ProviderSummaryRow>(
    `
      select status,
             consecutive_failures
      from provider_health_summary
      where provider_id = $1
        and (
          ($2::uuid is null and provider_model_id is null)
          or provider_model_id = $2::uuid
        )
    `,
    [providerId, providerModelId],
  );
  return result.rows[0] ?? null;
}

async function readHealthEvents(fixture: Fixture, providerId: string): Promise<HealthEventRow[]> {
  const result = await fixture.query<HealthEventRow>(
    `
      select trigger,
             status,
             error_code,
             provider_model_id::text
      from provider_health_events
      where provider_id = $1
      order by observed_at, id
    `,
    [providerId],
  );
  return result.rows;
}

async function readRequestActivity(
  fixture: Fixture,
  requestId: string,
): Promise<RequestActivityRow | null> {
  const result = await fixture.query<RequestActivityRow>(
    `
      select status,
             provider_model_id::text
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function listenForHealthNotifications(
  databaseUrl: string,
): Promise<HealthNotificationListener> {
  const client = new Client({ connectionString: databaseUrl });
  const payloads: Array<Record<string, unknown>> = [];
  client.on("notification", (message) => {
    if (message.channel !== HEALTH_SUMMARY_CHANGED_CHANNEL || !message.payload) {
      return;
    }
    payloads.push(JSON.parse(message.payload) as Record<string, unknown>);
  });
  await client.connect();
  await client.query(`listen ${HEALTH_SUMMARY_CHANGED_CHANNEL}`);

  return {
    close: async () => {
      await client.query(`unlisten ${HEALTH_SUMMARY_CHANGED_CHANNEL}`).catch(() => undefined);
      await client.end();
    },
    payloads,
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
      NODE_ENV: "test",
    },
  });
  const gateway: GatewayProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stdout.on("data", (chunk) => {
    gateway.stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    gateway.stderr.push(String(chunk));
  });
  return gateway;
}

async function waitForGateway(baseUrl: string, gateway: GatewayProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (gateway.child.exitCode !== null) {
          return `exited:${gateway.child.exitCode}`;
        }

        try {
          const response = await fetch(`${baseUrl}/health`);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      {
        message: `Gateway did not start.\nstdout=${gateway.stdout.join("")}\nstderr=${gateway.stderr.join("")}`,
        timeout: 15_000,
      },
    )
    .toBe(200);
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      gateway.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    gateway.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    gateway.child.kill("SIGTERM");
  });
}
