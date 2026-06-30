import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  buildLocalDeploymentRequestId,
  localDeploymentSmokeNames,
} from "../support/local-deployment-smoke";
import { withProcessLock } from "../support/process-lock";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-deploy-054";

test("clean local deployment records startup duration and completes one routed request", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_deploy_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    // PostgreSQL component: real isolated database with all migrations applied.
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedLocalDeployment(fixture, { providerBaseUrl: `${provider.url}/v1` });

    await withProcessLock("llmingress-console-next-dev", async () => {
      // Startup-to-first-successful-routed-request timer starts the moment we
      // bring the deployment up.
      const startedAt = Date.now();
      const worker = startWorkerProcess({ databaseUrl: fixture.databaseUrl });
      const gateway = startGatewayProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`;
        const consoleBaseUrl = `http://localhost:${consoleApp.port}`;

        // Health checks for all four components.
        await waitForGateway(gatewayBaseUrl, gateway);
        await waitForConsole(consoleBaseUrl, consoleApp);
        await waitForWorkerStarted(worker);

        const health = await (await fetch(`${gatewayBaseUrl}/health`)).json();
        expect(health).toMatchObject({ status: "ok", configVersion: 1 });
        expect(health.providerCount).toBeGreaterThanOrEqual(1);

        // One successful routed request through the live deployment.
        const requestId = buildLocalDeploymentRequestId("smoke");
        const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
          body: JSON.stringify({
            max_tokens: 8,
            messages: [{ content: "hello local deployment", role: "user" }],
            model: localDeploymentSmokeNames.virtualModelName,
            stream: false,
          }),
          headers: {
            authorization: `Bearer ${localDeploymentSmokeNames.agentApiKey}`,
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          method: "POST",
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          choices: [{ message: { content: "fake provider response" } }],
          object: "chat.completion",
        });
        expect(provider.requests).toHaveLength(1);

        const startupToFirstRequestMs = Date.now() - startedAt;
        expect(Number.isFinite(startupToFirstRequestMs)).toBe(true);
        expect(startupToFirstRequestMs).toBeGreaterThan(0);
        console.log(`startup_to_first_request_ms=${startupToFirstRequestMs}`);

        // The deployment recorded the routed request end to end.
        await expect
          .poll(() => readActivityStatus(fixture, requestId))
          .toMatchObject({ http_status: 200, status: "succeeded" });
      } finally {
        await stopProcess(gateway.child);
        await stopProcess(worker.child);
        await stopProcess(consoleApp.child);
      }
    });
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

const realSmokeEnabled =
  process.env.LLMINGRESS_REAL_SMOKE === "1" &&
  Boolean(process.env.OPENAI_API_KEY) &&
  Boolean(process.env.ANTHROPIC_API_KEY);

test("opt-in real provider smoke routes one openai and one anthropic request under a budget cap", async () => {
  test.skip(
    !realSmokeEnabled,
    "Set LLMINGRESS_REAL_SMOKE=1 with OPENAI_API_KEY and ANTHROPIC_API_KEY to run the real-provider smoke.",
  );

  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_deploy_real_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRealDeployment(fixture);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(gatewayBaseUrl, gateway);

      const openaiRequestId = buildLocalDeploymentRequestId("real-openai");
      const openaiResponse = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ content: "Reply with the single word: ok", role: "user" }],
          model: seeded.openaiVirtualModelName,
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${seeded.agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": openaiRequestId,
        },
        method: "POST",
      });
      expect(openaiResponse.status).toBe(200);
      await expect
        .poll(() => readActivityStatus(fixture, openaiRequestId))
        .toMatchObject({ http_status: 200, status: "succeeded" });

      const anthropicRequestId = buildLocalDeploymentRequestId("real-anthropic");
      const anthropicResponse = await fetch(`${gatewayBaseUrl}/v1/messages`, {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ content: "Reply with the single word: ok", role: "user" }],
          model: seeded.anthropicVirtualModelName,
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${seeded.agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": anthropicRequestId,
        },
        method: "POST",
      });
      expect(anthropicResponse.status).toBe(200);
      await expect
        .poll(() => readActivityStatus(fixture, anthropicRequestId))
        .toMatchObject({ http_status: 200, status: "succeeded" });
    } finally {
      await stopProcess(gateway.child);
    }
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type AppProcess = {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
};

type PortAppProcess = AppProcess & { port: number };

async function seedLocalDeployment(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [
      providerId,
      localDeploymentSmokeNames.providerKey,
      localDeploymentSmokeNames.providerDisplayName,
      input.providerBaseUrl,
    ],
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
        id, provider_id, model_id, display_name, context_window,
        supports_streaming, supports_tools, availability
      )
      values ($1, $2, $3, $4, 128000, true, true, 'available')
    `,
    [
      providerModelId,
      providerId,
      localDeploymentSmokeNames.providerModelId,
      localDeploymentSmokeNames.providerModelDisplayName,
    ],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
    [
      virtualModelId,
      localDeploymentSmokeNames.virtualModelName,
      localDeploymentSmokeNames.virtualModelDisplayName,
    ],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Local Deploy Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      localDeploymentSmokeNames.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(localDeploymentSmokeNames.agentApiKey),
      virtualModelId,
    ],
  );
  await fixture.query(
    "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Local deployment smoke config')",
  );
}

type RealDeploymentSeed = {
  agentApiKey: string;
  openaiVirtualModelName: string;
  anthropicVirtualModelName: string;
};

async function seedRealDeployment(fixture: Fixture): Promise<RealDeploymentSeed> {
  const agentApiKey = "llmi_realsmoke054_key";
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const openaiVirtualModelId = randomUUID();
  const anthropicVirtualModelId = randomUUID();
  const encryption = createSecretEncryption({ kind: "inline", value: masterKey });

  const openai = {
    baseUrl: "https://api.openai.com/v1",
    encrypted: encryption.encrypt(process.env.OPENAI_API_KEY as string),
    modelId: "gpt-4.1-mini",
    providerId: randomUUID(),
    providerKey: "openai",
    providerModelId: randomUUID(),
    routePolicyId: randomUUID(),
    virtualModelName: "real-smoke-openai",
  };
  const anthropic = {
    baseUrl: "https://api.anthropic.com/v1",
    encrypted: encryption.encrypt(process.env.ANTHROPIC_API_KEY as string),
    modelId: "claude-haiku-4-5",
    providerId: randomUUID(),
    providerKey: "anthropic",
    providerModelId: randomUUID(),
    routePolicyId: randomUUID(),
    virtualModelName: "real-smoke-anthropic",
  };

  for (const entry of [openai, anthropic]) {
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, $2, $3, true)
      `,
      [entry.providerId, entry.providerKey, entry.baseUrl],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, $3, $4, $5)
      `,
      [
        randomUUID(),
        entry.providerId,
        "sk-real",
        JSON.stringify(entry.encrypted),
        entry.encrypted.keyId,
      ],
    );
    await fixture.query(
      `
        insert into provider_models (
          id, provider_id, model_id, display_name, context_window,
          supports_streaming, supports_tools, availability,
          manual_input_usd_per_million_tokens, manual_output_usd_per_million_tokens,
          manual_price_updated_at
        )
        values ($1, $2, $3, $3, 128000, true, true, 'available', 1, 5, now())
      `,
      [entry.providerModelId, entry.providerId, entry.modelId],
    );
  }

  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, $2, $2, true), ($3, $4, $4, true)
    `,
    [
      openaiVirtualModelId,
      openai.virtualModelName,
      anthropicVirtualModelId,
      anthropic.virtualModelName,
    ],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed'), ($3, $4, 'fixed')
    `,
    [openai.routePolicyId, openaiVirtualModelId, anthropic.routePolicyId, anthropicVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
      values ($1, $2, $3, 1), ($4, $5, $6, 1)
    `,
    [
      randomUUID(),
      openai.routePolicyId,
      openai.providerModelId,
      randomUUID(),
      anthropic.routePolicyId,
      anthropic.providerModelId,
    ],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Real Smoke Agent', 'coding', true)",
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
      openaiVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2), ($1, $3)
    `,
    [agentApiKeyId, openaiVirtualModelId, anthropicVirtualModelId],
  );
  // Hard USD 10 budget cap so a runaway real-provider call cannot overspend.
  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'budget', 'month', 10, 'usd', true)
    `,
    [randomUUID(), agentApiKeyId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Real smoke config')",
  );

  return {
    agentApiKey,
    anthropicVirtualModelName: anthropic.virtualModelName,
    openaiVirtualModelName: openai.virtualModelName,
  };
}

async function readActivityStatus(
  fixture: Fixture,
  requestId: string,
): Promise<{ http_status: number | null; status: string } | null> {
  const result = await fixture.query<{ http_status: number | null; status: string }>(
    "select status, http_status from request_activity where request_id = $1",
    [requestId],
  );
  return result.rows[0] ?? null;
}

function startGatewayProcess(options: { databaseUrl: string; port: number }): PortAppProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "250",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return attachStreams({ child, port: options.port, stderr: [], stdout: [] });
}

function startConsoleProcess(options: { databaseUrl: string; port: number }): PortAppProcess {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@llmingress/console",
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(options.port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONSOLE_PORT: String(options.port),
        DATABASE_URL: options.databaseUrl,
        MASTER_KEY: masterKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return attachStreams({ child, port: options.port, stderr: [], stdout: [] });
}

function startWorkerProcess(options: { databaseUrl: string }): AppProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/worker", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      MASTER_KEY: masterKey,
      WORKER_HEARTBEAT_MS: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return attachStreams({ child, stderr: [], stdout: [] });
}

function attachStreams<T extends AppProcess>(app: T): T {
  app.child.stdout.on("data", (chunk) => app.stdout.push(String(chunk)));
  app.child.stderr.on("data", (chunk) => app.stderr.push(String(chunk)));
  return app;
}

async function waitForGateway(baseUrl: string, gateway: PortAppProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (gateway.child.exitCode !== null) {
          return `exited:${gateway.child.exitCode}`;
        }
        try {
          return (await fetch(`${baseUrl}/health`)).status;
        } catch {
          return "not-ready";
        }
      },
      {
        message: `Gateway did not start.\nstdout=${gateway.stdout.join("")}\nstderr=${gateway.stderr.join("")}`,
        timeout: 20_000,
      },
    )
    .toBe(200);
}

async function waitForConsole(baseUrl: string, consoleApp: PortAppProcess): Promise<void> {
  let lastObservedStatus = "not-started";

  await expect
    .poll(
      async () => {
        if (consoleApp.child.exitCode !== null) {
          return formatConsoleStartupFailure(consoleApp, lastObservedStatus);
        }
        try {
          const response = await fetch(baseUrl);
          if (response.status !== 200) {
            lastObservedStatus = `status:${response.status}:${(await response.text()).slice(0, 500)}`;
            return lastObservedStatus;
          }
          lastObservedStatus = String(response.status);
          return response.status;
        } catch (error) {
          lastObservedStatus = `fetch-error:${
            error instanceof Error ? error.message : String(error)
          }`;
          return "not-ready";
        }
      },
      {
        message: "Console did not start.",
        timeout: 30_000,
      },
    )
    .toBe(200);
}

function formatConsoleStartupFailure(
  consoleApp: PortAppProcess,
  lastObservedStatus: string,
): string {
  return [
    `exited:${consoleApp.child.exitCode}`,
    `last:${lastObservedStatus}`,
    `stdout:${consoleApp.stdout.join("")}`,
    `stderr:${consoleApp.stderr.join("")}`,
  ].join("\n");
}

async function waitForWorkerStarted(worker: AppProcess): Promise<void> {
  await expect
    .poll(
      () => {
        if (worker.child.exitCode !== null) {
          return `exited:${worker.child.exitCode}`;
        }
        return worker.stdout.join("").includes("[worker] started") ? "started" : "not-ready";
      },
      {
        message: `Worker did not start.\nstdout=${worker.stdout.join("")}\nstderr=${worker.stderr.join("")}`,
        timeout: 20_000,
      },
    )
    .toBe("started");
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
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
