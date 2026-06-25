import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const streamProviderApiKey = "sk-fake-provider-streaming-039";
const midstreamProviderApiKey = "sk-fake-provider-midstream-039";
const rateLimitProviderApiKey = "sk-fake-provider-rate-limit-039";
const expectedStreamBody =
  'data: {"delta":"fake"}\n\ndata: {"delta":" stream"}\n\ndata: [DONE]\n\n';

test("streaming chat responses and messages forward first chunk before provider completes preserve chunk order and record midstream error without replay", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_streaming_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_allowed_gateway_streaming_key_039";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedStreamingRoutes(fixture, {
      agentApiKey,
      midstreamBaseUrl: `${provider.url}/v1?mode=midstream-error`,
      rateLimitBaseUrl: `${provider.url}/v1?mode=rate-limit`,
      streamBaseUrl: `${provider.url}/v1?mode=stream`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectStreamingEndpoint(baseUrl, {
        apiKey: agentApiKey,
        body: {
          messages: [{ content: "hello streaming chat", role: "user" }],
          model: "stream-chat",
          stream: true,
        },
        path: "/v1/chat/completions",
        requestId: "req_stream_chat_039",
      });
      await expectStreamingEndpoint(baseUrl, {
        apiKey: agentApiKey,
        body: {
          input: "hello streaming responses",
          model: "stream-responses",
          stream: true,
        },
        path: "/v1/responses",
        requestId: "req_stream_responses_039",
      });
      await expectStreamingEndpoint(baseUrl, {
        apiKey: agentApiKey,
        body: {
          max_tokens: 64,
          messages: [{ content: "hello streaming messages", role: "user" }],
          model: "stream-messages",
          stream: true,
        },
        path: "/v1/messages",
        requestId: "req_stream_messages_039",
      });

      await expectMidstreamError(baseUrl, fixture, {
        apiKey: agentApiKey,
        requestId: "req_midstream_039",
      });
      await expectProviderRateLimit(baseUrl, fixture, {
        apiKey: agentApiKey,
        requestId: "req_provider_rate_limit_039",
      });
      expect(
        provider.requests.filter((request) => request.mode === "midstream-error"),
      ).toHaveLength(1);
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

type StreamingEndpointExpectation = {
  apiKey: string;
  body: Record<string, unknown>;
  path: "/v1/chat/completions" | "/v1/messages" | "/v1/responses";
  requestId: string;
};

async function seedStreamingRoutes(
  fixture: Fixture,
  input: {
    agentApiKey: string;
    midstreamBaseUrl: string;
    rateLimitBaseUrl: string;
    streamBaseUrl: string;
  },
): Promise<void> {
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const streamProviderId = randomUUID();
  const midstreamProviderId = randomUUID();
  const rateLimitProviderId = randomUUID();
  const streamProviderModelId = randomUUID();
  const midstreamProviderModelId = randomUUID();
  const rateLimitProviderModelId = randomUUID();
  const virtualModels = [
    { id: randomUUID(), modelId: streamProviderModelId, name: "stream-chat" },
    { id: randomUUID(), modelId: streamProviderModelId, name: "stream-responses" },
    { id: randomUUID(), modelId: streamProviderModelId, name: "stream-messages" },
    { id: randomUUID(), modelId: midstreamProviderModelId, name: "stream-mid-error" },
    {
      id: randomUUID(),
      modelId: rateLimitProviderModelId,
      name: "stream-provider-rate-limit",
    },
  ];
  const streamEncrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    streamProviderApiKey,
  );
  const midstreamEncrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    midstreamProviderApiKey,
  );
  const rateLimitEncrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    rateLimitProviderApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-streaming', 'Fake Streaming', $2, true),
             ($3, 'api_key', 'fake-midstream', 'Fake Midstream', $4, true),
             ($5, 'api_key', 'fake-rate-limit', 'Fake Rate Limit', $6, true)
    `,
    [
      streamProviderId,
      input.streamBaseUrl,
      midstreamProviderId,
      input.midstreamBaseUrl,
      rateLimitProviderId,
      input.rateLimitBaseUrl,
    ],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5),
             ($6, $7, $8, $9, $10),
             ($11, $12, $13, $14, $15)
    `,
    [
      randomUUID(),
      streamProviderId,
      streamProviderApiKey.slice(0, 8),
      JSON.stringify(streamEncrypted),
      streamEncrypted.keyId,
      randomUUID(),
      midstreamProviderId,
      midstreamProviderApiKey.slice(0, 8),
      JSON.stringify(midstreamEncrypted),
      midstreamEncrypted.keyId,
      randomUUID(),
      rateLimitProviderId,
      rateLimitProviderApiKey.slice(0, 8),
      JSON.stringify(rateLimitEncrypted),
      rateLimitEncrypted.keyId,
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
      values ($1, $2, 'stream-model', 'Stream Model', 128000, true, true, 'available'),
             ($3, $4, 'midstream-model', 'Midstream Model', 128000, true, true, 'available'),
             ($5, $6, 'rate-limit-model', 'Rate Limit Model', 128000, true, true, 'available')
    `,
    [
      streamProviderModelId,
      streamProviderId,
      midstreamProviderModelId,
      midstreamProviderId,
      rateLimitProviderModelId,
      rateLimitProviderId,
    ],
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
      [randomUUID(), routePolicyId, virtualModel.modelId],
    );
  }

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Streaming Agent', 'coding', true)",
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
             ($1, $4),
             ($1, $5),
             ($1, $6)
    `,
    [
      agentApiKeyId,
      virtualModels[0]?.id,
      virtualModels[1]?.id,
      virtualModels[2]?.id,
      virtualModels[3]?.id,
      virtualModels[4]?.id,
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Streaming endpoint config')",
  );
}

async function expectStreamingEndpoint(
  baseUrl: string,
  expectation: StreamingEndpointExpectation,
): Promise<void> {
  const startedAt = Date.now();
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
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = requireBody(response).getReader();
  const firstChunk = await readTextChunk(reader);
  expect(Date.now() - startedAt).toBeLessThan(500);
  const body = firstChunk + (await readRemainingText(reader));
  expect(body).toBe(expectedStreamBody);
}

async function expectMidstreamError(
  baseUrl: string,
  fixture: Fixture,
  input: { apiKey: string; requestId: string },
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "trigger midstream error", role: "user" }],
      model: "stream-mid-error",
      stream: true,
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const reader = requireBody(response).getReader();
  await expect(readTextChunk(reader)).resolves.toContain("fake");
  await expect(readRemainingText(reader)).rejects.toThrow();

  await expect.poll(async () => countRuntimeErrors(fixture), { timeout: 5_000 }).toBe(1);
}

async function expectProviderRateLimit(
  baseUrl: string,
  fixture: Fixture,
  input: { apiKey: string; requestId: string },
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "trigger provider rate limit", role: "user" }],
      model: "stream-provider-rate-limit",
      stream: true,
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(429);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: "provider_rate_limited" },
  });
  await expect
    .poll(async () => readRequestActivityError(fixture, input.requestId))
    .toEqual({
      error_code: "provider_rate_limited",
      http_status: 429,
    });
}

async function readRequestActivityError(fixture: Fixture, requestId: string) {
  const result = await fixture.query<{ error_code: string; http_status: number }>(
    `
      select error_code, http_status
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function countRuntimeErrors(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    "select count(*)::text as count from runtime_errors where error_code = 'provider_stream_error'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new Error("Expected streaming response body.");
  }
  return response.body;
}

async function readTextChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  if (chunk.done) {
    return "";
  }
  return Buffer.from(chunk.value).toString("utf8");
}

async function readRemainingText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return body;
    }
    body += Buffer.from(chunk.value).toString("utf8");
  }
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
