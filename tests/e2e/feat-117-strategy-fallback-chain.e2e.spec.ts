import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-fallback-117";
const agentApiKey = "llmi_strategy_fallback_chain_117";

test("strategy ordered fallback supports streaming and non streaming requests", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_strategy_fallback_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedStrategyFallbackRoute(fixture, {
      agentApiKey,
      // Candidate A always fails before first byte for both non-streaming and streaming.
      failedBaseUrl: `${provider.url}/v1?mode=first-byte-failure`,
      // Non-streaming success model uses json mode; streaming success model uses stream mode.
      nonStreamSuccessBaseUrl: `${provider.url}/v1`,
      streamSuccessBaseUrl: `${provider.url}/v1?mode=stream`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // --- Step 1: Non-streaming fallback ---
      const nonStreamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "hello non-streaming fallback", role: "user" }],
          model: seeded.nonStreamVirtualModelName,
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_ns_fallback_117",
        },
        method: "POST",
      });

      expect(nonStreamResponse.status).toBe(200);
      const nonStreamBody = await nonStreamResponse.json();
      expect(nonStreamBody).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });

      // A received first-byte-failure, B received json (success)
      const nonStreamRequests = [...provider.requests];
      expect(nonStreamRequests.map((r) => r.mode)).toContain("first-byte-failure");
      expect(nonStreamRequests.map((r) => r.mode)).toContain("json");
      // A was first, B was second
      const nonStreamFirstByte = nonStreamRequests.findIndex(
        (r) => r.mode === "first-byte-failure",
      );
      const nonStreamJson = nonStreamRequests.findIndex((r) => r.mode === "json");
      expect(nonStreamFirstByte).toBeLessThan(nonStreamJson);

      // Assert fallback_events in DB for the non-streaming request (looked up by request_id)
      await expectFallbackEvents(fixture, "req_ns_fallback_117", [
        {
          attempt_order: 1,
          error_code: "provider_request_failed",
          failed_before_first_byte: true,
          provider_model_id: seeded.failedProviderModelId,
          status: "failed",
        },
        {
          attempt_order: 2,
          error_code: null,
          failed_before_first_byte: false,
          provider_model_id: seeded.nonStreamSuccessProviderModelId,
          status: "succeeded",
        },
      ]);

      // --- Step 2: Streaming fallback before first byte ---
      const streamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "hello streaming fallback", role: "user" }],
          model: seeded.streamVirtualModelName,
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_stream_fallback_117",
        },
        method: "POST",
      });

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

      const reader = requireBody(streamResponse).getReader();
      const firstChunk = await readTextChunk(reader);
      const remaining = await readRemainingText(reader);
      const fullBody = firstChunk + remaining;

      // B's stream chunks should be present in order
      expect(fullBody).toContain("fake");
      expect(fullBody).toContain("[DONE]");
      // Confirm chunk ordering: "fake" appears before "[DONE]"
      const fakePos = fullBody.indexOf("fake");
      const donePos = fullBody.indexOf("[DONE]");
      expect(fakePos).toBeLessThan(donePos);

      // Provider received another first-byte-failure (A) and a stream (B)
      const streamRequests = provider.requests.slice(nonStreamRequests.length);
      expect(streamRequests.map((r) => r.mode)).toContain("first-byte-failure");
      expect(streamRequests.map((r) => r.mode)).toContain("stream");
      const streamFirstByte = streamRequests.findIndex((r) => r.mode === "first-byte-failure");
      const streamMode = streamRequests.findIndex((r) => r.mode === "stream");
      expect(streamFirstByte).toBeLessThan(streamMode);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

// ---- types ----

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type SeededStrategyFallbackRoute = {
  failedProviderModelId: string;
  nonStreamSuccessProviderModelId: string;
  nonStreamVirtualModelName: string;
  streamVirtualModelName: string;
};

type FallbackEventRow = {
  attempt_order: number;
  error_code: string | null;
  failed_before_first_byte: boolean;
  provider_model_id: string;
  status: string;
};

// ---- seeding ----

async function seedStrategyFallbackRoute(
  fixture: Fixture,
  input: {
    agentApiKey: string;
    failedBaseUrl: string;
    nonStreamSuccessBaseUrl: string;
    streamSuccessBaseUrl: string;
  },
): Promise<SeededStrategyFallbackRoute> {
  const encryption = createSecretEncryption({ kind: "inline", value: masterKey });

  // Three providers: one shared "failed" provider and two separate success providers
  // (one for non-streaming json mode, one for streaming stream mode).
  const failedProviderId = randomUUID();
  const nonStreamSuccessProviderId = randomUUID();
  const streamSuccessProviderId = randomUUID();

  const failedProviderModelId = randomUUID();
  const nonStreamSuccessProviderModelId = randomUUID();
  const streamSuccessProviderModelId = randomUUID();

  // Two virtual models: one for non-streaming fallback, one for streaming fallback.
  const nonStreamVirtualModelId = randomUUID();
  const nonStreamVirtualModelName = "strategy-fallback-ns-117";
  const streamVirtualModelId = randomUUID();
  const streamVirtualModelName = "strategy-fallback-stream-117";

  const nonStreamRoutePolicyId = randomUUID();
  const streamRoutePolicyId = randomUUID();

  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();

  // Insert three providers
  const encryptedKeyFailed = encryption.encrypt(providerApiKey);
  const encryptedKeyNonStream = encryption.encrypt(providerApiKey);
  const encryptedKeyStream = encryption.encrypt(providerApiKey);

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'sf-117-failed', 'SF 117 Failed', $2, true),
             ($3, 'api_key', 'sf-117-ns-success', 'SF 117 NS Success', $4, true),
             ($5, 'api_key', 'sf-117-stream-success', 'SF 117 Stream Success', $6, true)
    `,
    [
      failedProviderId,
      input.failedBaseUrl,
      nonStreamSuccessProviderId,
      input.nonStreamSuccessBaseUrl,
      streamSuccessProviderId,
      input.streamSuccessBaseUrl,
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
      failedProviderId,
      providerApiKey.slice(0, 8),
      JSON.stringify(encryptedKeyFailed),
      encryptedKeyFailed.keyId,
      randomUUID(),
      nonStreamSuccessProviderId,
      providerApiKey.slice(0, 8),
      JSON.stringify(encryptedKeyNonStream),
      encryptedKeyNonStream.keyId,
      randomUUID(),
      streamSuccessProviderId,
      providerApiKey.slice(0, 8),
      JSON.stringify(encryptedKeyStream),
      encryptedKeyStream.keyId,
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
      values ($1, $2, 'sf-117-primary', 'SF 117 Primary', 128000, true, true, 'available'),
             ($3, $4, 'sf-117-ns-fallback', 'SF 117 NS Fallback', 128000, true, true, 'available'),
             ($5, $6, 'sf-117-stream-fallback', 'SF 117 Stream Fallback', 128000, true, true, 'available')
    `,
    [
      failedProviderModelId,
      failedProviderId,
      nonStreamSuccessProviderModelId,
      nonStreamSuccessProviderId,
      streamSuccessProviderModelId,
      streamSuccessProviderId,
    ],
  );

  // Non-streaming virtual model + route policy (failed=order 1, ns-success=order 2)
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, $2, 'Strategy Fallback NS 117', true),
             ($3, $4, 'Strategy Fallback Stream 117', true)
    `,
    [
      nonStreamVirtualModelId,
      nonStreamVirtualModelName,
      streamVirtualModelId,
      streamVirtualModelName,
    ],
  );

  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed'),
             ($3, $4, 'fixed')
    `,
    [nonStreamRoutePolicyId, nonStreamVirtualModelId, streamRoutePolicyId, streamVirtualModelId],
  );

  // Both policies share the same "failed" candidate at order 1.
  // Non-stream policy success = nonStreamSuccessProviderModelId at order 2.
  // Stream policy success = streamSuccessProviderModelId at order 2.
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
      values ($1, $2, $3, 1),
             ($4, $2, $5, 2),
             ($6, $7, $8, 1),
             ($9, $7, $10, 2)
    `,
    [
      randomUUID(),
      nonStreamRoutePolicyId,
      failedProviderModelId,
      randomUUID(),
      nonStreamSuccessProviderModelId,
      randomUUID(),
      streamRoutePolicyId,
      failedProviderModelId,
      randomUUID(),
      streamSuccessProviderModelId,
    ],
  );

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'SF Agent 117', 'coding', true)",
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
      agentApiKeyId,
      agentId,
      input.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.agentApiKey),
      nonStreamVirtualModelId,
    ],
  );

  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3)
    `,
    [agentApiKeyId, nonStreamVirtualModelId, streamVirtualModelId],
  );

  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Strategy fallback chain 117 config')",
  );

  return {
    failedProviderModelId,
    nonStreamSuccessProviderModelId,
    nonStreamVirtualModelName,
    streamVirtualModelName,
  };
}

// ---- assertions ----

async function expectFallbackEvents(
  fixture: Fixture,
  requestId: string,
  expectedRows: FallbackEventRow[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await fixture.query<FallbackEventRow>(
          `
            select fe.provider_model_id::text,
                   fe.attempt_order,
                   fe.status,
                   fe.error_code,
                   fe.failed_before_first_byte
            from fallback_events fe
            join request_activity ra on ra.id = fe.request_activity_id
            where ra.request_id = $1
            order by fe.attempt_order
          `,
          [requestId],
        );
        return result.rows;
      },
      { timeout: 5_000 },
    )
    .toEqual(expectedRows);
}

// ---- gateway process helpers ----

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "0",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
      NODE_ENV: "test",
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

// ---- stream helpers ----

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
