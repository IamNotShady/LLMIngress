import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const agentApiKey = "llmi_gateway_ponytail_cleanup_key_123";
const providerApiKey = "sk-fake-provider-123";

test("gateway cleanup keeps public JSON endpoints and fallback behavior unchanged", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_gateway_ponytail_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedGatewayCleanupRoutes(fixture, `${provider.url}/v1`);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const models = await gatewayFetchJson(baseUrl, "/v1/models", {
        method: "GET",
      });
      expect(models.body).toMatchObject({
        data: expect.arrayContaining([
          { id: "cleanup-chat", object: "model" },
          { id: "cleanup-responses", object: "model" },
          { id: "cleanup-messages", object: "model" },
          { id: "cleanup-embeddings", object: "model" },
        ]),
        object: "list",
      });

      const chat = await gatewayFetchJson(baseUrl, "/v1/chat/completions", {
        body: {
          messages: [{ content: "hello fallback", role: "user" }],
          model: "cleanup-chat",
          stream: false,
        },
        requestId: "req_cleanup_chat_123",
      });
      expect(chat.status).toBe(200);
      expect(chat.body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
        id: "fake-provider-response",
      });

      const responses = await gatewayFetchJson(baseUrl, "/v1/responses", {
        body: {
          input: "hello responses",
          model: "cleanup-responses",
          stream: false,
        },
        requestId: "req_cleanup_responses_123",
      });
      expect(responses.status).toBe(200);
      expect(responses.body).toMatchObject({
        id: "fake-provider-response",
        object: "response",
      });

      const messages = await gatewayFetchJson(baseUrl, "/v1/messages", {
        body: {
          max_tokens: 64,
          messages: [{ content: "hello messages", role: "user" }],
          model: "cleanup-messages",
          stream: false,
        },
        requestId: "req_cleanup_messages_123",
      });
      expect(messages.status).toBe(200);
      expect(messages.body).toMatchObject({
        content: [{ text: "fake provider response", type: "text" }],
        id: "fake-provider-message",
      });

      const embeddings = await gatewayFetchJson(baseUrl, "/v1/embeddings", {
        body: {
          input: "hello embeddings",
          model: "cleanup-embeddings",
        },
        requestId: "req_cleanup_embeddings_123",
      });
      expect(embeddings.status).toBe(200);
      expect(embeddings.body).toMatchObject({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: "embedding" }],
        object: "list",
      });

      const chatRequests = provider.requests.filter((request) =>
        request.path.endsWith("/chat/completions"),
      );
      expect(chatRequests.map((request) => request.mode)).toEqual(["rate-limit", "json"]);
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

async function seedGatewayCleanupRoutes(fixture: Fixture, providerBaseUrl: string): Promise<void> {
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );
  const agentId = randomUUID();

  const chatFailure = await seedProviderModel(fixture, {
    baseUrl: `${providerBaseUrl}?mode=rate-limit`,
    encrypted,
    modelId: "gpt-4.1-mini",
    providerKey: "openai",
  });
  const chatSuccess = await seedProviderModel(fixture, {
    baseUrl: providerBaseUrl,
    encrypted,
    modelId: "gpt-4.1-mini",
    providerKey: "openai",
  });
  const responses = await seedProviderModel(fixture, {
    baseUrl: providerBaseUrl,
    encrypted,
    modelId: "gpt-4.1-mini",
    providerKey: "openai",
  });
  const messages = await seedProviderModel(fixture, {
    baseUrl: providerBaseUrl,
    encrypted,
    modelId: "claude-sonnet-4-5",
    providerKey: "anthropic",
  });
  const embeddings = await seedProviderModel(fixture, {
    baseUrl: `${providerBaseUrl}?mode=embeddings`,
    encrypted,
    modelId: "text-embedding-3-small",
    providerKey: "openai",
  });

  const virtualModels = [
    await seedVirtualModel(fixture, "cleanup-chat", [chatFailure, chatSuccess]),
    await seedVirtualModel(fixture, "cleanup-responses", [responses]),
    await seedVirtualModel(fixture, "cleanup-messages", [messages]),
    await seedVirtualModel(fixture, "cleanup-embeddings", [embeddings]),
  ];

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Cleanup Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents
      set key_prefix = $2,
          key_hash = $3,
          default_virtual_model_id = $4,
          enabled = true,
          updated_at = now()
      where id = $1
    `,
    [agentId, agentApiKey.slice(0, 12), buildGatewayAgentApiKeyHash(agentApiKey), virtualModels[0]],
  );
  for (const virtualModelId of virtualModels) {
    await fixture.query(
      "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
      [agentId, virtualModelId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Gateway ponytail cleanup config')",
  );
}

async function seedProviderModel(
  fixture: Fixture,
  input: {
    baseUrl: string;
    encrypted: ReturnType<ReturnType<typeof createSecretEncryption>["encrypt"]>;
    modelId: string;
    providerKey: string;
  },
): Promise<string> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [providerId, input.providerKey, `Cleanup ${input.providerKey}`, input.baseUrl],
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
      JSON.stringify(input.encrypted),
      input.encrypted.keyId,
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
        availability,
        manual_input_usd_per_million_tokens,
        manual_output_usd_per_million_tokens,
        manual_price_updated_at
      )
      values ($1, $2, $3, $3, 128000, true, true, 'available', 1, 1, now())
    `,
    [providerModelId, providerId, input.modelId],
  );

  return providerModelId;
}

async function seedVirtualModel(
  fixture: Fixture,
  name: string,
  providerModelIds: string[],
): Promise<string> {
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, $2, true)",
    [virtualModelId, name],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
  );
  for (const [index, providerModelId] of providerModelIds.entries()) {
    await fixture.query(
      `
        insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
        values ($1, $2, $3, $4)
      `,
      [randomUUID(), routePolicyId, providerModelId, index + 1],
    );
  }
  return virtualModelId;
}

async function gatewayFetchJson(
  baseUrl: string,
  path: string,
  input: {
    body?: unknown;
    method?: "GET" | "POST";
    requestId?: string;
  },
): Promise<{ body: unknown; status: number }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    headers: {
      authorization: `Bearer ${agentApiKey}`,
      "content-type": "application/json",
      ...(input.requestId ? { "x-request-id": input.requestId } : {}),
    },
    method: input.method ?? "POST",
  });

  return { body: await response.json(), status: response.status };
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
