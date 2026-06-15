import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  buildLimitsFallbackRequestId,
  type LimitsFallbackFailureScenario,
  limitsFallbackNames,
  listLimitsFallbackExpectedFailures,
} from "../support/limits-fallback";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-limits-fallback-053";

test("limits return expected errors and first byte failure falls back successfully", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_limits_fallback_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedLimitsFallbackGateway(fixture, {
      failedBaseUrl: `${provider.url}/v1?mode=first-byte-failure`,
      successBaseUrl: `${provider.url}/v1`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.rpm,
        model: limitsFallbackNames.virtualModels.rpm,
        requestId: buildLimitsFallbackRequestId("rpm-prime"),
        status: 200,
      });
      expect(provider.requests).toHaveLength(1);

      for (const failure of listLimitsFallbackExpectedFailures()) {
        await expectLimitFailure(baseUrl, seeded, failure);
      }
      expect(provider.requests).toHaveLength(1);

      await expectGatewayChat(baseUrl, {
        apiKey: seeded.keys.fallback,
        model: limitsFallbackNames.virtualModels.fallback,
        requestId: buildLimitsFallbackRequestId("fallback"),
        status: 200,
      });
      expect(provider.requests.map((request) => request.mode)).toEqual([
        "json",
        "first-byte-failure",
        "json",
      ]);

      await expect
        .poll(() => readFallbackActivity(fixture, buildLimitsFallbackRequestId("fallback")))
        .toEqual({
          fallback_attempts: [
            expect.objectContaining({
              attemptOrder: 1,
              errorCode: "provider_request_failed",
              errorMessage: expect.any(String),
              failedBeforeFirstByte: true,
              providerModelId: seeded.failedProviderModelId,
            }),
          ],
          http_status: 200,
          provider_model_id: seeded.successProviderModelId,
          status: "succeeded",
        });
      await expectFallbackEvents(fixture, {
        failedProviderModelId: seeded.failedProviderModelId,
        requestId: buildLimitsFallbackRequestId("fallback"),
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

type SeededLimitsFallbackGateway = {
  failedProviderModelId: string;
  keys: Record<LimitsFallbackFailureScenario | "fallback", string>;
  successProviderModelId: string;
};

type ChatExpectation = {
  apiKey: string;
  expectedCode?: string;
  expectedLimitType?: "rpm" | "tpm";
  maxTokens?: number;
  model: string;
  requestId: string;
  status: 200 | 402 | 429;
};

type FallbackActivityRow = {
  fallback_attempts: unknown;
  http_status: number;
  provider_model_id: string | null;
  status: string;
};

async function expectLimitFailure(
  baseUrl: string,
  seeded: SeededLimitsFallbackGateway,
  failure: ReturnType<typeof listLimitsFallbackExpectedFailures>[number],
): Promise<void> {
  await expectGatewayChat(baseUrl, {
    apiKey: seeded.keys[failure.scenario],
    expectedCode: failure.errorCode,
    expectedLimitType: failure.limitType,
    maxTokens: failure.scenario === "tpm" ? 64 : 128,
    model: limitsFallbackNames.virtualModels[failure.scenario],
    requestId: buildLimitsFallbackRequestId(failure.scenario),
    status: failure.status,
  });
}

async function seedLimitsFallbackGateway(
  fixture: Fixture,
  input: { failedBaseUrl: string; successBaseUrl: string },
): Promise<SeededLimitsFallbackGateway> {
  const agentId = randomUUID();
  const successProviderId = randomUUID();
  const failedProviderId = randomUUID();
  const successProviderModelId = randomUUID();
  const failedProviderModelId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );
  const keyRows = {
    budget: { apiKey: "llmi_bud053_key_053", id: randomUUID() },
    fallback: { apiKey: "llmi_fbk053_key_053", id: randomUUID() },
    rpm: { apiKey: "llmi_rpm053_key_053", id: randomUUID() },
    token: { apiKey: "llmi_tok053_key_053", id: randomUUID() },
    tpm: { apiKey: "llmi_tpm053_key_053", id: randomUUID() },
  };
  const routeRows = {
    budget: { routePolicyId: randomUUID(), virtualModelId: randomUUID() },
    fallback: { routePolicyId: randomUUID(), virtualModelId: randomUUID() },
    rpm: { routePolicyId: randomUUID(), virtualModelId: randomUUID() },
    token: { routePolicyId: randomUUID(), virtualModelId: randomUUID() },
    tpm: { routePolicyId: randomUUID(), virtualModelId: randomUUID() },
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Limits Success Provider', $2, true),
             ($3, 'api_key', 'limits-failed-provider', 'Limits Failed Provider', $4, true)
    `,
    [successProviderId, input.successBaseUrl, failedProviderId, input.failedBaseUrl],
  );
  for (const providerId of [successProviderId, failedProviderId]) {
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
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 128000, true, true, 'available'),
             ($3, $4, 'failed-first-byte-model', 'Failed First Byte', 128000, true, true, 'available')
    `,
    [successProviderModelId, successProviderId, failedProviderModelId, failedProviderId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Limits Fallback Agent', 'coding', true)",
    [agentId],
  );

  for (const [scenario, route] of Object.entries(routeRows)) {
    await fixture.query(
      "insert into virtual_models (id, name, display_name, enabled) values ($1, $2, $3, true)",
      [
        route.virtualModelId,
        limitsFallbackNames.virtualModels[
          scenario as keyof typeof limitsFallbackNames.virtualModels
        ],
        scenario,
      ],
    );
    await fixture.query(
      "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
      [route.routePolicyId, route.virtualModelId],
    );
  }

  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order, is_fallback)
      values ($1, $2, $3, 1, false),
             ($4, $5, $3, 1, false),
             ($6, $7, $3, 1, false),
             ($8, $9, $3, 1, false),
             ($10, $11, $12, 1, false),
             ($13, $11, $3, 2, true)
    `,
    [
      randomUUID(),
      routeRows.rpm.routePolicyId,
      successProviderModelId,
      randomUUID(),
      routeRows.tpm.routePolicyId,
      randomUUID(),
      routeRows.token.routePolicyId,
      randomUUID(),
      routeRows.budget.routePolicyId,
      randomUUID(),
      routeRows.fallback.routePolicyId,
      failedProviderModelId,
      randomUUID(),
    ],
  );

  for (const [scenario, key] of Object.entries(keyRows)) {
    const route = routeRows[scenario as keyof typeof routeRows];
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
        key.id,
        agentId,
        key.apiKey.slice(0, 12),
        buildGatewayAgentApiKeyHash(key.apiKey),
        route.virtualModelId,
      ],
    );
    await fixture.query(
      `
        insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id)
        values ($1, $2)
      `,
      [key.id, route.virtualModelId],
    );
  }

  await fixture.query(
    `
      insert into agent_limits (id, agent_api_key_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'rpm', 'minute', 1, 'requests', true),
             ($3, $4, 'tpm', 'minute', 10, 'tokens', true),
             ($5, $6, 'token', 'request', 20, 'tokens', true),
             ($7, $8, 'budget', 'month', 0.000001, 'usd', true)
    `,
    [
      randomUUID(),
      keyRows.rpm.id,
      randomUUID(),
      keyRows.tpm.id,
      randomUUID(),
      keyRows.token.id,
      randomUUID(),
      keyRows.budget.id,
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Limits fallback config')",
  );

  return {
    failedProviderModelId,
    keys: {
      budget: keyRows.budget.apiKey,
      fallback: keyRows.fallback.apiKey,
      rpm: keyRows.rpm.apiKey,
      token: keyRows.token.apiKey,
      tpm: keyRows.tpm.apiKey,
    },
    successProviderModelId,
  };
}

async function expectGatewayChat(baseUrl: string, expectation: ChatExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: expectation.maxTokens ?? 8,
      messages: [{ content: "hello limits fallback", role: "user" }],
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
    expect(body).toMatchObject({
      error: {
        code: expectation.expectedCode,
        message: expect.any(String),
      },
      requestId: expectation.requestId,
    });
    if (expectation.expectedLimitType) {
      expect(body.limitType).toBe(expectation.expectedLimitType);
    }
    return;
  }

  expect(body).toMatchObject({
    choices: [{ message: { content: "fake provider response", role: "assistant" } }],
    id: "fake-provider-response",
    object: "chat.completion",
  });
}

async function readFallbackActivity(
  fixture: Fixture,
  requestId: string,
): Promise<FallbackActivityRow | null> {
  const result = await fixture.query<FallbackActivityRow>(
    `
      select status,
             http_status,
             provider_model_id::text,
             fallback_attempts
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function expectFallbackEvents(
  fixture: Fixture,
  input: { failedProviderModelId: string; requestId: string },
): Promise<void> {
  const result = await fixture.query<{
    error_code: string | null;
    failed_before_first_byte: boolean;
    provider_model_id: string;
    request_id: string;
    status: string;
  }>(
    `
      select fallback_events.status,
             fallback_events.error_code,
             fallback_events.failed_before_first_byte,
             fallback_events.provider_model_id::text,
             request_activity.request_id
      from fallback_events
      join request_activity on request_activity.id = fallback_events.request_activity_id
      where request_activity.request_id = $1
      order by fallback_events.attempt_order
    `,
    [input.requestId],
  );

  expect(result.rows).toEqual([
    {
      error_code: "provider_request_failed",
      failed_before_first_byte: true,
      provider_model_id: input.failedProviderModelId,
      request_id: input.requestId,
      status: "failed",
    },
  ]);
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
