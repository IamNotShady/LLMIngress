import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-concurrency-107";

test("concurrency limits increment release and respect block or warn enforcement policy", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_concurrency_limits_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedConcurrencyGateway(fixture, {
      errorBaseUrl: `${provider.url}/v1?mode=error`,
      jsonBaseUrl: `${provider.url}/v1`,
      streamBaseUrl: `${provider.url}/v1?mode=stream&stream_end_ms=5000`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const blockStream = await startGatewayStream(baseUrl, {
        apiKey: seeded.keys.block.apiKey,
        requestId: "req_concurrency_block_stream_107",
      });
      await waitForActiveCount(fixture, seeded.keys.block.id, 1);
      const providerCallsBeforeBlock = provider.requests.length;
      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.block.apiKey,
        expectedLimitType: "concurrency",
        requestId: "req_concurrency_blocked_107",
        status: 429,
      });
      expect(provider.requests).toHaveLength(providerCallsBeforeBlock);
      await drainStream(blockStream);
      await waitForActiveCount(fixture, seeded.keys.block.id, 0);
      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.block.apiKey,
        requestId: "req_concurrency_after_release_107",
        status: 200,
      });

      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.failure.apiKey,
        model: "concurrency-error",
        requestId: "req_concurrency_failure_release_107",
        status: 502,
      });
      await waitForActiveCount(fixture, seeded.keys.failure.id, 0);

      const abortStream = await startGatewayStream(baseUrl, {
        apiKey: seeded.keys.abort.apiKey,
        requestId: "req_concurrency_abort_stream_107",
      });
      await waitForActiveCount(fixture, seeded.keys.abort.id, 1);
      await abortStream.body?.cancel();
      await waitForActiveCount(fixture, seeded.keys.abort.id, 0);

      const warnStream = await startGatewayStream(baseUrl, {
        apiKey: seeded.keys.warn.apiKey,
        requestId: "req_concurrency_warn_stream_107",
      });
      await waitForActiveCount(fixture, seeded.keys.warn.id, 1);
      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.warn.apiKey,
        requestId: "req_concurrency_warn_allowed_107",
        status: 200,
      });
      await drainStream(warnStream);
      await waitForActiveCount(fixture, seeded.keys.warn.id, 0);

      const bypassStream = await startGatewayStream(baseUrl, {
        apiKey: seeded.keys.bypass.apiKey,
        requestId: "req_concurrency_bypass_stream_107",
      });
      await waitForActiveCount(fixture, seeded.keys.bypass.id, 1);
      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.bypass.apiKey,
        requestId: "req_concurrency_bypass_allowed_107",
        status: 200,
      });
      await drainStream(bypassStream);
      await waitForActiveCount(fixture, seeded.keys.bypass.id, 0);
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

type SeededKey = {
  apiKey: string;
  id: string;
};

type SeededConcurrencyGateway = {
  keys: Record<"abort" | "block" | "bypass" | "failure" | "warn", SeededKey>;
};

type ChatExpectation = {
  apiKey: string;
  expectedLimitType?: "concurrency";
  model?: string;
  requestId: string;
  status: 200 | 429 | 502;
};

async function seedConcurrencyGateway(
  fixture: Fixture,
  input: { errorBaseUrl: string; jsonBaseUrl: string; streamBaseUrl: string },
): Promise<SeededConcurrencyGateway> {
  const agentId = randomUUID();
  const keys = {
    abort: { apiKey: "llmi107abort_key_107", id: randomUUID() },
    block: { apiKey: "llmi107block_key_107", id: randomUUID() },
    bypass: { apiKey: "llmi107bypass_key_107", id: randomUUID() },
    failure: { apiKey: "llmi107failure_key_107", id: randomUUID() },
    warn: { apiKey: "llmi107warn_key_107", id: randomUUID() },
  };
  const providers = {
    error: { baseUrl: input.errorBaseUrl, id: randomUUID(), key: "fake-concurrency-error" },
    json: { baseUrl: input.jsonBaseUrl, id: randomUUID(), key: "fake-concurrency-json" },
    stream: { baseUrl: input.streamBaseUrl, id: randomUUID(), key: "fake-concurrency-stream" },
  };
  const models = {
    error: { id: randomUUID(), providerId: providers.error.id, modelId: "concurrency-error-model" },
    json: { id: randomUUID(), providerId: providers.json.id, modelId: "concurrency-json-model" },
    stream: {
      id: randomUUID(),
      providerId: providers.stream.id,
      modelId: "concurrency-stream-model",
    },
  };
  const virtualModels = {
    error: { id: randomUUID(), modelId: models.error.id, name: "concurrency-error" },
    json: { id: randomUUID(), modelId: models.json.id, name: "concurrency-json" },
    stream: { id: randomUUID(), modelId: models.stream.id, name: "concurrency-stream" },
  };
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  for (const provider of Object.values(providers)) {
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, $3, $4, true)
      `,
      [provider.id, provider.key, provider.key, provider.baseUrl],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, $3, $4, $5)
      `,
      [
        randomUUID(),
        provider.id,
        providerApiKey.slice(0, 8),
        JSON.stringify(encrypted),
        encrypted.keyId,
      ],
    );
  }

  for (const model of Object.values(models)) {
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
        values ($1, $2, $3, $3, 128000, true, true, 'available')
      `,
      [model.id, model.providerId, model.modelId],
    );
  }

  for (const virtualModel of Object.values(virtualModels)) {
    const routePolicyId = randomUUID();
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, $2, $2, true)",
      [virtualModel.id, virtualModel.name],
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
          candidate_order
        )
        values ($1, $2, $3, 1)
      `,
      [randomUUID(), routePolicyId, virtualModel.modelId],
    );
  }

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Concurrency Agent', 'coding', true)",
    [agentId],
  );
  for (const key of Object.values(keys)) {
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
        values ($1, 'Concurrency Agent', 'coding', $2, $3, $4, true)
      `,
      [
        key.id,
        key.apiKey.slice(0, 12),
        buildGatewayAgentApiKeyHash(key.apiKey),
        virtualModels.json.id,
      ],
    );
    for (const virtualModel of Object.values(virtualModels)) {
      await fixture.query(
        `
          insert into agent_virtual_models (agent_id, virtual_model_id)
          values ($1, $2)
        `,
        [key.id, virtualModel.id],
      );
    }
  }

  await fixture.query(
    `
      insert into agent_limits (
        id,
        agent_id,
        limit_type,
        period,
        limit_value,
        unit,
        enabled,
        alert_threshold,
        enforcement_policy,
        manual_bypass
      )
      values ($1, $2, 'concurrency', 'request', 1, 'requests', true, 0.8, 'block', false),
             ($3, $4, 'concurrency', 'request', 1, 'requests', true, 0.8, 'warn_only', false),
             ($5, $6, 'concurrency', 'request', 1, 'requests', true, 0.8, 'block', true),
             ($7, $8, 'concurrency', 'request', 1, 'requests', true, null, 'block', false),
             ($9, $10, 'concurrency', 'request', 1, 'requests', true, null, 'block', false)
    `,
    [
      randomUUID(),
      keys.block.id,
      randomUUID(),
      keys.warn.id,
      randomUUID(),
      keys.bypass.id,
      randomUUID(),
      keys.failure.id,
      randomUUID(),
      keys.abort.id,
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Concurrency config')",
  );

  return { keys };
}

async function startGatewayStream(
  baseUrl: string,
  input: { apiKey: string; requestId: string },
): Promise<Response> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 8,
      messages: [{ content: "hold concurrency", role: "user" }],
      model: "concurrency-stream",
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
  return response;
}

async function expectGatewayChat(baseUrl: string, expectation: ChatExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 8,
      messages: [{ content: "hello concurrency", role: "user" }],
      model: expectation.model ?? "concurrency-json",
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

  if (expectation.status === 429) {
    expect(response.headers.get("retry-after")).toBe("1");
    expect(body).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "Agent API key exceeded its CONCURRENCY limit.",
      },
      limitType: expectation.expectedLimitType,
      requestId: expectation.requestId,
      retryAfterMs: 1,
      retryAfterSeconds: 1,
    });
    return;
  }

  if (expectation.status === 502) {
    expect(body).toMatchObject({
      error: { code: "provider_request_failed" },
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

async function drainStream(response: Response): Promise<void> {
  await response.text();
}

async function waitForActiveCount(
  fixture: Fixture,
  agentApiKeyId: string,
  expected: number,
): Promise<void> {
  await expect
    .poll(() => readActiveCount(fixture, agentApiKeyId), {
      message: `Expected concurrency active_count=${expected}`,
      timeout: 10_000,
    })
    .toBe(expected);
}

async function readActiveCount(fixture: Fixture, agentApiKeyId: string): Promise<number> {
  const result = await fixture.query<{ active_count: number | null }>(
    `
      select active_count
      from rate_limit_windows
      where agent_id = $1
        and limit_type = 'concurrency'
      order by updated_at desc
      limit 1
    `,
    [agentApiKeyId],
  );
  return Number(result.rows[0]?.active_count ?? 0);
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
