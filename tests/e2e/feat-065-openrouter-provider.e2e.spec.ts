import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createModelRefreshJobHandler } from "@llmingress/db/worker-model-refresh";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-or-v1-openrouter-e2e-secret";
const agentApiKey = "llmi_openrouter_gateway_key_065";
const openRouterModelId = "openai/gpt-4o-mini";

test("openrouter template adapter gateway chat model refresh and error mapping work", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_openrouter_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({
    models: [{ id: openRouterModelId, name: "OpenAI GPT-4o Mini" }],
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenRouterRoute(fixture, {
      providerBaseUrl: `${server.url}/api/v1`,
    });

    await runModelRefreshJob(fixture, seeded.providerId);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/models",
    });
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${providerApiKey}`);
    expect(server.requests[0]?.headers["http-referer"]).toBe("https://llmingress.local");
    expect(server.requests[0]?.headers["x-openrouter-title"]).toBe("LLMIngress");
    await expectProviderModelRows(fixture, [
      {
        availability: "available",
        display_name: "OpenAI GPT-4o Mini",
        model_id: openRouterModelId,
      },
    ]);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "hello through openrouter", role: "user" }],
          model: "openrouter-coding",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_openrouter_065",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
        id: "fake-provider-response",
      });
      expect(server.requests[1]).toMatchObject({
        bodyJson: {
          messages: [{ content: "hello through openrouter", role: "user" }],
          model: openRouterModelId,
          stream: false,
        },
        method: "POST",
        path: "/api/v1/chat/completions",
      });
      expect(server.requests[1]?.headers.authorization).toBe(`Bearer ${providerApiKey}`);
      expect(server.requests[1]?.headers["http-referer"]).toBe("https://llmingress.local");
      expect(server.requests[1]?.headers["x-openrouter-title"]).toBe("LLMIngress");

      const streamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "stream through openrouter", role: "user" }],
          model: "openrouter-coding",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_openrouter_stream_065",
        },
        method: "POST",
      });

      expect(streamResponse.status).toBe(200);
      await streamResponse.text();
      expect(server.requests[2]).toMatchObject({
        bodyJson: {
          messages: [{ content: "stream through openrouter", role: "user" }],
          model: openRouterModelId,
          stream: true,
        },
        method: "POST",
        path: "/api/v1/chat/completions",
      });
      expect(server.requests[2]?.headers.authorization).toBe(`Bearer ${providerApiKey}`);
      expect(server.requests[2]?.headers["http-referer"]).toBe("https://llmingress.local");
      expect(server.requests[2]?.headers["x-openrouter-title"]).toBe("LLMIngress");

      await fixture.query("update providers set base_url = $1 where id = $2", [
        `${server.url}/api/v1?mode=openrouter-error`,
        seeded.providerId,
      ]);
      const errorResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "trigger openrouter mapped error", role: "user" }],
          model: "openrouter-coding",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_openrouter_error_065",
        },
        method: "POST",
      });

      expect(errorResponse.status).toBe(502);
      await expect(errorResponse.json()).resolves.toMatchObject({
        error: { code: "provider_request_failed" },
        requestId: "req_openrouter_error_065",
      });
      expect(server.requests[3]?.headers["http-referer"]).toBe("https://llmingress.local");
      expect(server.requests[3]?.headers["x-openrouter-title"]).toBe("LLMIngress");
      await expectOpenRouterFallbackError(fixture);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await server.close();
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

type SeededOpenRouterRoute = {
  providerId: string;
};

type ProviderModelRow = {
  availability: string;
  display_name: string;
  model_id: string;
};

async function seedOpenRouterRoute(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<SeededOpenRouterRoute> {
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
      insert into providers (
        id,
        provider_type,
        provider_key,
        provider_template_id,
        display_name,
        base_url,
        enabled
      )
      values ($1, 'api_key', 'openrouter', 'openrouter', 'OpenRouter', $2, true)
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
      values ($1, $2, $3, 'OpenAI GPT-4o Mini', 128000, true, true, 'available')
    `,
    [providerModelId, providerId, openRouterModelId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'openrouter-coding', 'OpenRouter Coding', true)
    `,
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
        candidate_order
      )
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'OpenRouter Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
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
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'OpenRouter route config')",
  );

  return { providerId };
}

async function runModelRefreshJob(fixture: Fixture, providerId: string): Promise<void> {
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      model_refresh: createModelRefreshJobHandler({
        databaseUrl: fixture.databaseUrl,
        masterKeySource: { kind: "inline", value: masterKey },
      }),
    },
    workerId: `worker-openrouter-${randomUUID()}`,
  });
  const jobId = randomUUID();

  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'model_refresh', 'pending', 'manual', $2, 1)
    `,
    [jobId, JSON.stringify({ providerId })],
  );

  await runner.runOnce();

  const result = await fixture.query<{ error_message: string | null; status: string }>(
    "select status, error_message from jobs where id = $1",
    [jobId],
  );
  expect(result.rows[0]).toEqual({
    error_message: null,
    status: "succeeded",
  });
}

async function expectProviderModelRows(
  fixture: Fixture,
  expectedRows: ProviderModelRow[],
): Promise<void> {
  const result = await fixture.query<ProviderModelRow>(
    `
      select model_id, display_name, availability
      from provider_models
      order by model_id
    `,
  );
  expect(result.rows).toEqual(expectedRows);
}

async function expectOpenRouterFallbackError(fixture: Fixture): Promise<void> {
  const result = await fixture.query<{
    error_code: string;
    error_message: string;
    failed_before_first_byte: boolean;
  }>(
    `
      select fallback_events.error_code,
             fallback_events.error_message,
             fallback_events.failed_before_first_byte
      from fallback_events
      join request_activity on request_activity.id = fallback_events.request_activity_id
      where request_activity.request_id = 'req_openrouter_error_065'
    `,
  );

  expect(result.rows).toEqual([
    {
      error_code: "openrouter_402",
      error_message: "OpenRouter account has insufficient credits",
      failed_before_first_byte: false,
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
