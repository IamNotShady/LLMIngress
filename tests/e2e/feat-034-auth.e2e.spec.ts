import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-auth-034";

test("valid key returns 200 and missing invalid disabled keys return 401 with stable error code and request id", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_gateway_auth_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const validKey = "llmi_valid_gateway_auth_key_034";
  const disabledKey = "llmi_disabled_gateway_auth_key_034";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedAgentApiKeys(fixture, {
      disabledKey,
      providerBaseUrl: `${provider.url}/v1`,
      validKey,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayAuth(baseUrl, {
        expectedCode: "missing_agent_api_key",
        requestId: "req_missing_034",
        status: 401,
      });
      await expectGatewayAuth(baseUrl, {
        apiKey: "llmi_invalid_gateway_auth_key_034",
        expectedCode: "invalid_agent_api_key",
        requestId: "req_invalid_034",
        status: 401,
      });
      await expectGatewayAuth(baseUrl, {
        apiKey: disabledKey,
        expectedCode: "disabled_agent_api_key",
        requestId: "req_disabled_034",
        status: 401,
      });
      await expectGatewayAuth(baseUrl, {
        apiKey: validKey,
        requestId: "req_valid_034",
        status: 200,
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

type GatewayAuthExpectation = {
  apiKey?: string;
  expectedCode?: string;
  requestId: string;
  status: 200 | 401;
};

async function seedAgentApiKeys(
  fixture: Fixture,
  input: { disabledKey: string; providerBaseUrl: string; validKey: string },
): Promise<void> {
  const agentId = randomUUID();
  const validKeyId = randomUUID();
  const codingVirtualModelId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const routePolicyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-openai-auth', 'Fake OpenAI Auth', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
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
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'coding', 'Coding', true)
    `,
    [codingVirtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Gateway Auth Agent', 'coding', true)",
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
      validKeyId,
      agentId,
      input.validKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.validKey),
      codingVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
      values ($1, 'Gateway Auth Disabled Agent', 'coding', $2, $3, false)
    `,
    [randomUUID(), input.disabledKey.slice(0, 12), buildGatewayAgentApiKeyHash(input.disabledKey)],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [validKeyId, codingVirtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, codingVirtualModelId],
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
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Gateway auth config')",
  );
}

async function expectGatewayAuth(
  baseUrl: string,
  expectation: GatewayAuthExpectation,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": expectation.requestId,
  };
  if (expectation.apiKey) {
    headers.authorization = `Bearer ${expectation.apiKey}`;
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "hello", role: "user" }],
      model: "coding",
    }),
    headers,
    method: "POST",
  });
  expect(response.status).toBe(expectation.status);
  const body = await response.json();

  if (expectation.status === 401) {
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
    id: "fake-provider-response",
    object: "chat.completion",
  });
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
        message: "Gateway did not start.",
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
    gateway.child.once("exit", () => resolve());
    setTimeout(() => {
      if (gateway.child.exitCode === null) {
        gateway.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
