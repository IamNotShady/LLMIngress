import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-messages-038";

test("messages returns provider response and rejects disallowed virtual model without calling provider", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_messages_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_allowed_gateway_messages_key_038";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedMessagesRoute(fixture, {
      agentApiKey,
      providerBaseUrl: `${provider.url}/v1`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayMessage(baseUrl, {
        apiKey: agentApiKey,
        expectedCode: "virtual_model_not_allowed",
        model: "blocked-messages",
        requestId: "req_blocked_038",
        status: 403,
      });
      expect(provider.requests).toHaveLength(0);

      await expectGatewayMessage(baseUrl, {
        apiKey: agentApiKey,
        model: "messages-coding",
        requestId: "req_allowed_038",
        status: 200,
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        bodyJson: {
          max_tokens: 64,
          messages: [{ content: "hello from feat 038", role: "user" }],
          model: "claude-sonnet-4-5",
          stream: false,
        },
        method: "POST",
        path: "/v1/messages",
      });
      expect(provider.requests[0]?.headers["x-api-key"]).toBe(providerApiKey);
      expect(provider.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
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

type GatewayMessagesExpectation = {
  apiKey: string;
  expectedCode?: string;
  model: string;
  requestId: string;
  status: 200 | 403;
};

async function seedMessagesRoute(
  fixture: Fixture,
  input: { agentApiKey: string; providerBaseUrl: string },
): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const allowedVirtualModelId = randomUUID();
  const blockedVirtualModelId = randomUUID();
  const allowedRoutePolicyId = randomUUID();
  const blockedRoutePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-anthropic', 'Fake Anthropic', $2, true)
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
      values ($1, $2, 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 200000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'messages-coding', 'Messages Coding', true),
             ($2, 'blocked-messages', 'Blocked Messages', true)
    `,
    [allowedVirtualModelId, blockedVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed'),
             ($3, $4, 'fixed')
    `,
    [allowedRoutePolicyId, allowedVirtualModelId, blockedRoutePolicyId, blockedVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order
      )
      values ($1, $2, $3, 1),
             ($4, $5, $3, 1)
    `,
    [randomUUID(), allowedRoutePolicyId, providerModelId, randomUUID(), blockedRoutePolicyId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Messages Agent', 'coding', true)",
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
      allowedVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, allowedVirtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Messages endpoint config')",
  );
}

async function expectGatewayMessage(
  baseUrl: string,
  expectation: GatewayMessagesExpectation,
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    body: JSON.stringify({
      max_tokens: 64,
      messages: [{ content: "hello from feat 038", role: "user" }],
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
    content: [{ text: "fake provider response", type: "text" }],
    id: "fake-provider-message",
    role: "assistant",
    type: "message",
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
    gateway.child.once("exit", () => resolve());
    setTimeout(() => {
      if (gateway.child.exitCode === null) {
        gateway.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
