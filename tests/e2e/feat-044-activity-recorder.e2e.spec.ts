import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-activity-044";

test("success and failure requests create activity rows with route fallback latency and error code", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_activity_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_activity_gateway_key_044";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedActivityRoutes(fixture, {
      agentApiKey,
      failedFallbackBaseUrl: `${provider.url}/v1?mode=first-byte-failure`,
      hardFailureBaseUrl: `${provider.url}/v1?mode=error`,
      successBaseUrl: `${provider.url}/v1`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayChat(baseUrl, {
        apiKey: agentApiKey,
        model: "activity-fallback",
        requestId: "req_activity_success_044",
        status: 200,
      });
      await expectGatewayChat(baseUrl, {
        apiKey: agentApiKey,
        expectedCode: "provider_request_failed",
        model: "activity-failure",
        requestId: "req_activity_failure_044",
        status: 502,
      });

      await expect
        .poll(() => readActivities(fixture))
        .toEqual([
          {
            agent_key_prefix: agentApiKey.slice(0, 12),
            error_code: null,
            fallback_attempts: [
              expect.objectContaining({
                attemptOrder: 1,
                errorCode: "provider_request_failed",
                errorMessage: expect.any(String),
                failedBeforeFirstByte: true,
                providerModelId: seeded.failedFallbackProviderModelId,
              }),
            ],
            http_status: 200,
            model: "activity-fallback",
            provider_model_id: seeded.successProviderModelId,
            request_id: "req_activity_success_044",
            route_policy_id: seeded.fallbackRoutePolicyId,
            route_reason: expect.objectContaining({
              message: "fixed route for activity-fallback selected configured candidate 1.",
              selectedCandidateOrder: 1,
              strategy: "fixed",
            }),
            status: "succeeded",
            virtual_model_id: seeded.fallbackVirtualModelId,
          },
          {
            agent_key_prefix: agentApiKey.slice(0, 12),
            error_code: "provider_request_failed",
            fallback_attempts: [
              expect.objectContaining({
                attemptOrder: 1,
                errorCode: "fake_provider_error",
                errorMessage: expect.any(String),
                failedBeforeFirstByte: false,
                providerModelId: seeded.hardFailureProviderModelId,
              }),
            ],
            http_status: 502,
            model: "activity-failure",
            provider_model_id: seeded.hardFailureProviderModelId,
            request_id: "req_activity_failure_044",
            route_policy_id: seeded.failureRoutePolicyId,
            route_reason: expect.objectContaining({
              message: "fixed route for activity-failure selected configured candidate 1.",
              selectedCandidateOrder: 1,
              strategy: "fixed",
            }),
            status: "failed",
            virtual_model_id: seeded.failureVirtualModelId,
          },
        ]);
      const latencyRows = await readActivityLatencies(fixture);
      expect(latencyRows).toHaveLength(2);
      expect(latencyRows.every((row) => row.latency_ms >= 0 && row.completed_at)).toBe(true);

      const fallbackEvents = await readFallbackEvents(fixture);
      expect(fallbackEvents).toEqual([
        {
          error_code: "provider_request_failed",
          failed_before_first_byte: true,
          provider_model_id: seeded.failedFallbackProviderModelId,
          request_id: "req_activity_success_044",
        },
        {
          error_code: null,
          failed_before_first_byte: false,
          provider_model_id: seeded.successProviderModelId,
          request_id: "req_activity_success_044",
        },
        {
          error_code: "fake_provider_error",
          failed_before_first_byte: false,
          provider_model_id: seeded.hardFailureProviderModelId,
          request_id: "req_activity_failure_044",
        },
      ]);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
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

type SeededActivityRoutes = {
  failedFallbackProviderModelId: string;
  failureRoutePolicyId: string;
  failureVirtualModelId: string;
  fallbackRoutePolicyId: string;
  fallbackVirtualModelId: string;
  hardFailureProviderModelId: string;
  successProviderModelId: string;
};

type GatewayChatExpectation = {
  apiKey: string;
  expectedCode?: string;
  model: string;
  requestId: string;
  status: 200 | 502;
};

type ActivityRow = {
  agent_key_prefix: string;
  error_code: string | null;
  fallback_attempts: unknown;
  http_status: number;
  model: string;
  provider_model_id: string | null;
  request_id: string;
  route_policy_id: string | null;
  route_reason: unknown;
  status: string;
  virtual_model_id: string | null;
};

type ActivityLatencyRow = {
  completed_at: Date | null;
  latency_ms: number;
};

type FallbackEventRow = {
  error_code: string | null;
  failed_before_first_byte: boolean;
  provider_model_id: string;
  request_id: string;
};

async function seedActivityRoutes(
  fixture: Fixture,
  input: {
    agentApiKey: string;
    failedFallbackBaseUrl: string;
    hardFailureBaseUrl: string;
    successBaseUrl: string;
  },
): Promise<SeededActivityRoutes> {
  const failedFallbackProviderId = randomUUID();
  const successProviderId = randomUUID();
  const hardFailureProviderId = randomUUID();
  const failedFallbackProviderModelId = randomUUID();
  const successProviderModelId = randomUUID();
  const hardFailureProviderModelId = randomUUID();
  const fallbackVirtualModelId = randomUUID();
  const failureVirtualModelId = randomUUID();
  const fallbackRoutePolicyId = randomUUID();
  const failureRoutePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'activity-fallback-fail', 'Activity Fallback Fail', $2, true),
             ($3, 'api_key', 'activity-fallback-success', 'Activity Fallback Success', $4, true),
             ($5, 'api_key', 'activity-hard-failure', 'Activity Hard Failure', $6, true)
    `,
    [
      failedFallbackProviderId,
      input.failedFallbackBaseUrl,
      successProviderId,
      input.successBaseUrl,
      hardFailureProviderId,
      input.hardFailureBaseUrl,
    ],
  );
  for (const providerId of [failedFallbackProviderId, successProviderId, hardFailureProviderId]) {
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
      values ($1, $2, 'gpt-4.1-mini', 'Primary Failure', 128000, true, true, 'available'),
             ($3, $4, 'gpt-4.1-mini', 'Fallback Success', 128000, true, true, 'available'),
             ($5, $6, 'gpt-4.1-mini', 'Hard Failure', 128000, true, true, 'available')
    `,
    [
      failedFallbackProviderModelId,
      failedFallbackProviderId,
      successProviderModelId,
      successProviderId,
      hardFailureProviderModelId,
      hardFailureProviderId,
    ],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'activity-fallback', 'Activity Fallback', true),
             ($2, 'activity-failure', 'Activity Failure', true)
    `,
    [fallbackVirtualModelId, failureVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed'),
             ($3, $4, 'fixed')
    `,
    [fallbackRoutePolicyId, fallbackVirtualModelId, failureRoutePolicyId, failureVirtualModelId],
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
             ($4, $2, $5, 2, true),
             ($6, $7, $8, 1, false)
    `,
    [
      randomUUID(),
      fallbackRoutePolicyId,
      failedFallbackProviderModelId,
      randomUUID(),
      successProviderModelId,
      randomUUID(),
      failureRoutePolicyId,
      hardFailureProviderModelId,
    ],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Activity Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      input.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.agentApiKey),
      fallbackVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3)
    `,
    [agentApiKeyId, fallbackVirtualModelId, failureVirtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Activity recorder config')",
  );

  return {
    failedFallbackProviderModelId,
    failureRoutePolicyId,
    failureVirtualModelId,
    fallbackRoutePolicyId,
    fallbackVirtualModelId,
    hardFailureProviderModelId,
    successProviderModelId,
  };
}

async function expectGatewayChat(
  baseUrl: string,
  expectation: GatewayChatExpectation,
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "hello from feat 044", role: "user" }],
      model: expectation.model,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${expectation.apiKey}`,
      "content-type": "application/json",
      "x-request-id": expectation.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(expectation.status);
  const body = await response.json();

  if (expectation.status !== 200) {
    expect(body).toEqual({
      error: {
        code: expectation.expectedCode,
        message: expect.any(String),
      },
      requestId: expectation.requestId,
    });
    return;
  }

  expect(body).toMatchObject({
    choices: [{ message: { content: "fake provider response", role: "assistant" } }],
    id: "fake-provider-response",
    object: "chat.completion",
  });
}

async function readActivities(fixture: Fixture): Promise<ActivityRow[]> {
  const result = await fixture.query<ActivityRow>(
    `
      select request_id,
             agent_key_prefix,
             virtual_model_id::text,
             route_policy_id::text,
             provider_model_id::text,
             model,
             route_reason,
             fallback_attempts,
             status,
             error_code,
             http_status
      from request_activity
      where request_id in ('req_activity_success_044', 'req_activity_failure_044')
      order by request_id desc
    `,
  );

  return result.rows;
}

async function readActivityLatencies(fixture: Fixture): Promise<ActivityLatencyRow[]> {
  const result = await fixture.query<ActivityLatencyRow>(
    `
      select latency_ms,
             completed_at
      from request_activity
      where request_id in ('req_activity_success_044', 'req_activity_failure_044')
      order by request_id
    `,
  );
  return result.rows;
}

async function readFallbackEvents(fixture: Fixture): Promise<FallbackEventRow[]> {
  const result = await fixture.query<FallbackEventRow>(
    `
      select request_activity.request_id,
             fallback_events.provider_model_id::text,
             fallback_events.error_code,
             fallback_events.failed_before_first_byte
      from fallback_events
      join request_activity on request_activity.id = fallback_events.request_activity_id
      where request_activity.request_id in ('req_activity_success_044', 'req_activity_failure_044')
      order by request_activity.request_id desc, fallback_events.attempt_order
    `,
  );
  return result.rows;
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

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "0",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gateway: GatewayProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => gateway.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => gateway.stdout.push(String(chunk)));
  return gateway;
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  gateway.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    gateway.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
