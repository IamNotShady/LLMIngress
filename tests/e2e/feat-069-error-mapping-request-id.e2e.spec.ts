import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-trace-069";
const normalAgentApiKey = "llmi_trace_normal_key_069";
const limitedAgentApiKey = "llmi_trace_limited_key_069";

test("provider auth routing limit errors and success failure streaming responses carry request id", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_error_trace_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedErrorTraceGateway(fixture, {
      errorBaseUrl: `${provider.url}/v1?mode=error`,
      streamBaseUrl: `${provider.url}/v1?mode=stream`,
      successBaseUrl: `${provider.url}/v1`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const authResponse = await postChat(baseUrl, {
        model: "trace-success",
        requestId: "req_auth_069",
      });
      expect(authResponse.status).toBe(401);
      expect(authResponse.headers.get("x-request-id")).toBe("req_auth_069");
      await expect(authResponse.json()).resolves.toMatchObject({
        error: { code: "missing_agent_api_key" },
        requestId: "req_auth_069",
      });

      const successResponse = await postChat(baseUrl, {
        apiKey: normalAgentApiKey,
        model: "trace-success",
        requestId: "req_success_069",
      });
      expect(successResponse.status).toBe(200);
      expect(successResponse.headers.get("x-request-id")).toBe("req_success_069");
      await expect(successResponse.json()).resolves.toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      await expectActivityRow(fixture, "req_success_069", {
        error_code: null,
        http_status: 200,
        status: "succeeded",
      });

      const providerErrorResponse = await postChat(baseUrl, {
        apiKey: normalAgentApiKey,
        model: "trace-provider-error",
        requestId: "req_provider_error_069",
      });
      expect(providerErrorResponse.status).toBe(502);
      expect(providerErrorResponse.headers.get("x-request-id")).toBe("req_provider_error_069");
      await expect(providerErrorResponse.json()).resolves.toMatchObject({
        error: { code: "provider_request_failed" },
        requestId: "req_provider_error_069",
      });
      await expectActivityRow(fixture, "req_provider_error_069", {
        error_code: "provider_request_failed",
        http_status: 502,
        status: "failed",
      });

      const routingResponse = await postChat(baseUrl, {
        apiKey: normalAgentApiKey,
        model: "trace-routing-missing",
        requestId: "req_routing_error_069",
      });
      expect(routingResponse.status).toBe(404);
      expect(routingResponse.headers.get("x-request-id")).toBe("req_routing_error_069");
      await expect(routingResponse.json()).resolves.toMatchObject({
        error: { code: "route_not_found" },
        requestId: "req_routing_error_069",
      });
      await expectActivityRow(fixture, "req_routing_error_069", {
        error_code: "route_not_found",
        http_status: 404,
        status: "failed",
      });

      const limitResponse = await postChat(baseUrl, {
        apiKey: limitedAgentApiKey,
        model: "trace-success",
        requestId: "req_limit_error_069",
      });
      expect(limitResponse.status).toBe(429);
      expect(limitResponse.headers.get("x-request-id")).toBe("req_limit_error_069");
      expect(limitResponse.headers.get("retry-after")).toEqual(expect.any(String));
      await expect(limitResponse.json()).resolves.toMatchObject({
        error: { code: "rate_limit_exceeded" },
        requestId: "req_limit_error_069",
      });
      await expectActivityRow(fixture, "req_limit_error_069", {
        error_code: "rate_limit_exceeded",
        http_status: 429,
        status: "failed",
      });

      const streamResponse = await postChat(baseUrl, {
        apiKey: normalAgentApiKey,
        model: "trace-stream",
        requestId: "req_stream_success_069",
        stream: true,
      });
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("x-request-id")).toBe("req_stream_success_069");
      await expect(streamResponse.text()).resolves.toContain("data: [DONE]");
      await expectActivityRow(fixture, "req_stream_success_069", {
        error_code: null,
        http_status: 200,
        status: "succeeded",
      });
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

type ActivityExpectation = {
  error_code: string | null;
  http_status: number;
  status: string;
};

type ActivityRow = ActivityExpectation & {
  request_id: string;
};

async function postChat(
  baseUrl: string,
  input: { apiKey?: string; model: string; requestId: string; stream?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": input.requestId,
  };
  if (input.apiKey) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }

  return fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 16,
      messages: [{ content: `trace ${input.requestId}`, role: "user" }],
      model: input.model,
      stream: input.stream ?? false,
    }),
    headers,
    method: "POST",
  });
}

async function expectActivityRow(
  fixture: Fixture,
  requestId: string,
  expectation: ActivityExpectation,
): Promise<void> {
  await expect
    .poll(() => readActivityRow(fixture, requestId))
    .toEqual({
      ...expectation,
      request_id: requestId,
    });
}

async function readActivityRow(fixture: Fixture, requestId: string): Promise<ActivityRow | null> {
  const result = await fixture.query<ActivityRow>(
    `
      select request_id,
             status,
             http_status,
             error_code
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function seedErrorTraceGateway(
  fixture: Fixture,
  input: { errorBaseUrl: string; streamBaseUrl: string; successBaseUrl: string },
): Promise<void> {
  const successProviderId = randomUUID();
  const errorProviderId = randomUUID();
  const streamProviderId = randomUUID();
  const successProviderModelId = randomUUID();
  const errorProviderModelId = randomUUID();
  const streamProviderModelId = randomUUID();
  const successVirtualModelId = randomUUID();
  const errorVirtualModelId = randomUUID();
  const routingVirtualModelId = randomUUID();
  const streamVirtualModelId = randomUUID();
  const successRoutePolicyId = randomUUID();
  const errorRoutePolicyId = randomUUID();
  const streamRoutePolicyId = randomUUID();
  const agentId = randomUUID();
  const normalAgentApiKeyId = randomUUID();
  const limitedAgentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await insertProvider(fixture, {
    baseUrl: input.successBaseUrl,
    displayName: "Trace Success",
    id: successProviderId,
    providerKey: "trace-success",
  });
  await insertProvider(fixture, {
    baseUrl: input.errorBaseUrl,
    displayName: "Trace Error",
    id: errorProviderId,
    providerKey: "trace-error",
  });
  await insertProvider(fixture, {
    baseUrl: input.streamBaseUrl,
    displayName: "Trace Stream",
    id: streamProviderId,
    providerKey: "trace-stream",
  });
  for (const providerId of [successProviderId, errorProviderId, streamProviderId]) {
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

  await insertProviderModel(fixture, {
    id: successProviderModelId,
    providerId: successProviderId,
  });
  await insertProviderModel(fixture, {
    id: errorProviderModelId,
    providerId: errorProviderId,
  });
  await insertProviderModel(fixture, {
    id: streamProviderModelId,
    providerId: streamProviderId,
  });
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'trace-success', 'Trace Success', true),
             ($2, 'trace-provider-error', 'Trace Provider Error', true),
             ($3, 'trace-routing-missing', 'Trace Routing Missing', true),
             ($4, 'trace-stream', 'Trace Stream', true)
    `,
    [successVirtualModelId, errorVirtualModelId, routingVirtualModelId, streamVirtualModelId],
  );
  await insertRoutePolicy(fixture, {
    id: successRoutePolicyId,
    providerModelId: successProviderModelId,
    virtualModelId: successVirtualModelId,
  });
  await insertRoutePolicy(fixture, {
    id: errorRoutePolicyId,
    providerModelId: errorProviderModelId,
    virtualModelId: errorVirtualModelId,
  });
  await insertRoutePolicy(fixture, {
    id: streamRoutePolicyId,
    providerModelId: streamProviderModelId,
    virtualModelId: streamVirtualModelId,
  });

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Trace Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents
      set id = $1,
          key_prefix = $3,
          key_hash = $4,
          default_virtual_model_id = $5,
          enabled = true,
          updated_at = now()
      where id = $2
    `,
    [
      normalAgentApiKeyId,
      agentId,
      normalAgentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(normalAgentApiKey),
      successVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, 'Trace Limited Agent', 'coding', $2, $3, $4, true)
    `,
    [
      limitedAgentApiKeyId,
      limitedAgentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(limitedAgentApiKey),
      successVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $3),
             ($1, $4),
             ($1, $5),
             ($1, $6),
             ($2, $3)
    `,
    [
      normalAgentApiKeyId,
      limitedAgentApiKeyId,
      successVirtualModelId,
      errorVirtualModelId,
      routingVirtualModelId,
      streamVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'tpm', 'minute', 1, 'tokens', true)
    `,
    [randomUUID(), limitedAgentApiKeyId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Error trace config')",
  );
}

async function insertProvider(
  fixture: Fixture,
  input: { baseUrl: string; displayName: string; id: string; providerKey: string },
): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [input.id, input.providerKey, input.displayName, input.baseUrl],
  );
}

async function insertProviderModel(
  fixture: Fixture,
  input: { id: string; providerId: string },
): Promise<void> {
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
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 128000, true, true, 'available')
    `,
    [input.id, input.providerId],
  );
}

async function insertRoutePolicy(
  fixture: Fixture,
  input: { id: string; providerModelId: string; virtualModelId: string },
): Promise<void> {
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [input.id, input.virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order, is_fallback)
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), input.id, input.providerModelId],
  );
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
