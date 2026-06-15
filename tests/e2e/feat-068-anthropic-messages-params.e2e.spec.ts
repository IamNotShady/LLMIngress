import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-params-068";
const agentApiKey = "llmi_messages_params_key_068";

test("anthropic messages passthrough preserves sampling stop metadata and safe parameters", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_messages_params_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedMessagesParamsRoute(fixture, {
      providerBaseUrl: `${provider.url}/v1`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/messages`, {
        body: JSON.stringify(buildMessagesParamsBody()),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_messages_params_068",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [{ text: "fake provider response", type: "text" }],
        id: "fake-provider-message",
        role: "assistant",
        type: "message",
      });

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        bodyJson: {
          max_tokens: 2048,
          messages: [{ content: "Preserve V1 Anthropic parameters.", role: "user" }],
          metadata: { user_id: "agent-params-068" },
          model: "claude-sonnet-4-5",
          service_tier: "auto",
          stop_sequences: ["</final>", "STOP_HERE"],
          temperature: 0.3,
          thinking: { budget_tokens: 1024, type: "enabled" },
          top_k: 40,
          top_p: 0.8,
        },
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": providerApiKey,
        },
        method: "POST",
        path: "/v1/messages",
      });
      expect(provider.requests[0]?.bodyJson).not.toHaveProperty("anthropic_beta");
      expect(provider.requests[0]?.bodyJson).not.toHaveProperty("extra_headers");
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

function buildMessagesParamsBody() {
  return {
    anthropic_beta: "unsafe-header-style-param",
    extra_headers: { "x-api-key": "do-not-forward" },
    max_tokens: 2048,
    messages: [{ content: "Preserve V1 Anthropic parameters.", role: "user" }],
    metadata: { user_id: "agent-params-068" },
    model: "messages-params",
    service_tier: "auto",
    stop_sequences: ["</final>", "STOP_HERE"],
    temperature: 0.3,
    thinking: { budget_tokens: 1024, type: "enabled" },
    top_k: 40,
    top_p: 0.8,
  };
}

async function seedMessagesParamsRoute(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'anthropic', 'Anthropic', $2, true)
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
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'messages-params', 'Messages Params', true)
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
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order, is_fallback)
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Messages Params Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      insert into agent_api_keys (
        id,
        agent_id,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, $2, $3, $4, $5, true)
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
      insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Messages params config')",
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
