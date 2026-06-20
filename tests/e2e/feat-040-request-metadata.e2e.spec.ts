import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-metadata-040";
const metadataHeader = "x-llmingress-request-metadata";

test("chat responses and messages metadata includes model stream message count tools and token estimates", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_metadata_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_allowed_gateway_metadata_key_040";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedMetadataRoutes(fixture, {
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

      await expectGatewayMetadata(baseUrl, {
        apiKey: agentApiKey,
        body: {
          max_tokens: 64,
          messages: [
            { content: "You are concise.", role: "system" },
            { content: "Explain request metadata.", role: "user" },
          ],
          model: "chat-metadata",
          stream: false,
          tools: [{ function: { name: "lookup_repo" }, type: "function" }],
        },
        expected: {
          estimatedOutputTokens: 64,
          messageCount: 2,
          model: "chat-metadata",
          protocol: "chat_completions",
          stream: false,
          usesTools: true,
        },
        path: "/v1/chat/completions",
        requestId: "req_metadata_chat_040",
      });

      await expectGatewayMetadata(baseUrl, {
        apiKey: agentApiKey,
        body: {
          input: [
            { content: "Summarize the metadata plan.", role: "user" },
            { content: "Keep it short.", role: "assistant" },
          ],
          max_output_tokens: 96,
          model: "responses-metadata",
          stream: false,
          tools: [{ name: "search", type: "web_search_preview" }],
        },
        expected: {
          estimatedOutputTokens: 96,
          messageCount: 2,
          model: "responses-metadata",
          protocol: "responses",
          stream: false,
          usesTools: true,
        },
        path: "/v1/responses",
        requestId: "req_metadata_responses_040",
      });

      await expectGatewayMetadata(baseUrl, {
        apiKey: agentApiKey,
        body: {
          max_tokens: 128,
          messages: [
            { content: "Review this metadata extraction.", role: "user" },
            { content: "Look for risks.", role: "assistant" },
          ],
          model: "messages-metadata",
          stream: false,
          system: "You are a reviewer.",
          tools: [{ input_schema: { type: "object" }, name: "read_file" }],
        },
        expected: {
          estimatedOutputTokens: 128,
          messageCount: 2,
          model: "messages-metadata",
          protocol: "messages",
          stream: false,
          usesTools: true,
        },
        path: "/v1/messages",
        requestId: "req_metadata_messages_040",
      });

      expect(provider.requests.map((request) => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/messages",
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

type MetadataExpectation = {
  apiKey: string;
  body: Record<string, unknown>;
  expected: Record<string, unknown>;
  path: "/v1/chat/completions" | "/v1/messages" | "/v1/responses";
  requestId: string;
};

async function seedMetadataRoutes(
  fixture: Fixture,
  input: { agentApiKey: string; providerBaseUrl: string },
): Promise<void> {
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModels = [
    { id: randomUUID(), name: "chat-metadata" },
    { id: randomUUID(), name: "responses-metadata" },
    { id: randomUUID(), name: "messages-metadata" },
  ];
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-metadata', 'Fake Metadata', $2, true)
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
      values ($1, $2, 'metadata-provider-model', 'Metadata Provider Model', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );

  for (const virtualModel of virtualModels) {
    const routePolicyId = randomUUID();
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
      [virtualModel.id, virtualModel.name, virtualModel.name],
    );
    await fixture.query(
      "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
      [routePolicyId, virtualModel.id],
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
  }

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Metadata Agent', 'coding', true)",
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
      virtualModels[0]?.id,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3),
             ($1, $4)
    `,
    [agentApiKeyId, virtualModels[0]?.id, virtualModels[1]?.id, virtualModels[2]?.id],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Request metadata config')",
  );
}

async function expectGatewayMetadata(
  baseUrl: string,
  expectation: MetadataExpectation,
): Promise<void> {
  const response = await fetch(`${baseUrl}${expectation.path}`, {
    body: JSON.stringify(expectation.body),
    headers: {
      authorization: `Bearer ${expectation.apiKey}`,
      "content-type": "application/json",
      "x-request-id": expectation.requestId,
    },
    method: "POST",
  });

  expect(response.status).toBe(200);
  const metadata = readMetadataHeader(response);
  expect(metadata).toMatchObject(expectation.expected);
  expect(metadata.estimatedInputTokens).toEqual(expect.any(Number));
  expect(metadata.estimatedInputTokens).toBeGreaterThan(0);
  await response.text();
}

function readMetadataHeader(response: Response): Record<string, unknown> {
  const header = response.headers.get(metadataHeader);
  if (!header) {
    throw new Error(`Expected ${metadataHeader} response header.`);
  }
  return JSON.parse(header) as Record<string, unknown>;
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
      GATEWAY_DEBUG_REQUEST_METADATA: "true",
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
