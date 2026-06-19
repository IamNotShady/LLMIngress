import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-rate-limit-041";

test("rpm and tpm over limit return 429 with retry-after and reset window allows later request", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_rate_limits_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const rpmKey = "llmi_rpm_limited_gateway_key_041";
  const tpmKey = "llmi_tpm_limited_gateway_key_041";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRateLimitedGateway(fixture, {
      providerBaseUrl: `${provider.url}/v1`,
      rpmKey,
      tpmKey,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayChat(baseUrl, {
        apiKey: rpmKey,
        requestId: "req_rpm_first_041",
        status: 200,
      });
      await expectGatewayChat(baseUrl, {
        apiKey: rpmKey,
        requestId: "req_rpm_second_041",
        status: 200,
      });
      await expectGatewayChat(baseUrl, {
        apiKey: rpmKey,
        expectedLimitType: "rpm",
        requestId: "req_rpm_blocked_041",
        status: 429,
      });
      expect(provider.requests).toHaveLength(2);

      await expireRateLimitWindows(fixture, seeded.rpmAgentApiKeyId);
      await expectGatewayChat(baseUrl, {
        apiKey: rpmKey,
        requestId: "req_rpm_after_reset_041",
        status: 200,
      });
      expect(provider.requests).toHaveLength(3);

      await expectGatewayChat(baseUrl, {
        apiKey: tpmKey,
        maxTokens: 64,
        requestId: "req_tpm_first_041",
        status: 200,
      });
      await expectGatewayChat(baseUrl, {
        apiKey: tpmKey,
        expectedLimitType: "tpm",
        maxTokens: 64,
        requestId: "req_tpm_blocked_041",
        status: 429,
      });
      expect(provider.requests).toHaveLength(4);

      await expireRateLimitWindows(fixture, seeded.tpmAgentApiKeyId);
      await expectGatewayChat(baseUrl, {
        apiKey: tpmKey,
        maxTokens: 64,
        requestId: "req_tpm_after_reset_041",
        status: 200,
      });
      expect(provider.requests).toHaveLength(5);
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

type RateLimitedSeed = {
  rpmAgentApiKeyId: string;
  tpmAgentApiKeyId: string;
};

type ChatExpectation = {
  apiKey: string;
  expectedLimitType?: "rpm" | "tpm";
  maxTokens?: number;
  requestId: string;
  status: 200 | 429;
};

async function seedRateLimitedGateway(
  fixture: Fixture,
  input: { providerBaseUrl: string; rpmKey: string; tpmKey: string },
): Promise<RateLimitedSeed> {
  const agentId = randomUUID();
  const rpmAgentApiKeyId = randomUUID();
  const tpmAgentApiKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-rate-limit', 'Fake Rate Limit', $2, true)
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
    "insert into virtual_models (id, name, display_name, enabled) values ($1, 'rate-limited-coding', 'Rate Limited Coding', true)",
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
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
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Rate Limited Agent', 'coding', true)",
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
      rpmAgentApiKeyId,
      agentId,
      input.rpmKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.rpmKey),
      virtualModelId,
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
      values ($1, 'Rate Limited TPM Agent', 'coding', $2, $3, $4, true)
    `,
    [
      tpmAgentApiKeyId,
      input.tpmKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.tpmKey),
      virtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $3),
             ($2, $3)
    `,
    [rpmAgentApiKeyId, tpmAgentApiKeyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'rpm', 'minute', 2, 'requests', true),
             ($3, $2, 'tpm', 'minute', 100000, 'tokens', true),
             ($4, $5, 'rpm', 'minute', 10, 'requests', true),
             ($6, $5, 'tpm', 'minute', 100, 'tokens', true)
    `,
    [randomUUID(), rpmAgentApiKeyId, randomUUID(), randomUUID(), tpmAgentApiKeyId, randomUUID()],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Rate limit config')",
  );

  return { rpmAgentApiKeyId, tpmAgentApiKeyId };
}

async function expectGatewayChat(baseUrl: string, expectation: ChatExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: expectation.maxTokens ?? 8,
      messages: [{ content: "hello rate limit", role: "user" }],
      model: "rate-limited-coding",
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
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(body).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: expect.any(String),
      },
      limitType: expectation.expectedLimitType,
      requestId: expectation.requestId,
      retryAfterMs: expect.any(Number),
      retryAfterSeconds: expect.any(Number),
    });
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    return;
  }

  expect(body).toMatchObject({
    id: "fake-provider-response",
    object: "chat.completion",
  });
}

async function expireRateLimitWindows(fixture: Fixture, agentApiKeyId: string): Promise<void> {
  await fixture.query(
    `
      update rate_limit_windows
      set window_start = window_start - interval '1 minute',
          window_end = window_end - interval '1 minute'
      where agent_id = $1
    `,
    [agentApiKeyId],
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
