import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, type Page, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-playground-049";

test("playground uses pasted key in memory direct gateway call and usage increments", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_playground_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_playground_live_key_049";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedPlaygroundRoute(fixture, {
      agentApiKey,
      providerBaseUrl: `${provider.url}/v1`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(gatewayBaseUrl, gateway);

      await withProcessLock("llmingress-console-next-dev", async () => {
        const consoleApp = startConsoleProcess({
          databaseUrl: fixture.databaseUrl,
          gatewayBaseUrl,
          port: await getFreePort(),
        });

        try {
          const consoleBaseUrl = `http://localhost:${consoleApp.port}`;
          const context = await browser.newContext();
          const page = await context.newPage();

          try {
            await waitForConsole(consoleBaseUrl, consoleApp);
            await signInFromFirstRun(page, consoleBaseUrl);
            await page.goto(`${consoleBaseUrl}/usage`);
            await expect(
              page
                .getByLabel("Usage")
                .locator(".stat-card", { hasText: "Total requests" })
                .locator(".stat-card-value"),
            ).toHaveText("0");

            await page.goto(`${consoleBaseUrl}/playground`);
            const playgroundSection = page.getByLabel("Playground");
            await expect(
              playgroundSection.getByRole("heading", { exact: true, name: "请求配置" }),
            ).toBeVisible();
            await expect(playgroundSection.getByLabel("Gateway base URL")).toHaveCount(0);

            const apiKeyInput = playgroundSection.getByLabel(/Agent API Key/);
            await apiKeyInput.fill(agentApiKey);
            const virtualModelSelect = playgroundSection.getByLabel(/Virtual Model/);
            await expect(virtualModelSelect).toContainText(seeded.virtualModelName);
            await virtualModelSelect.selectOption(seeded.virtualModelName);
            await expect(playgroundSection.getByLabel(/Endpoint/)).toHaveValue("chat_completions");
            await playgroundSection.getByLabel(/Prompt$/).fill("hello from feat 049");
            await playgroundSection.getByLabel(/System Prompt/).fill("answer as a test assistant");
            await playgroundSection.getByRole("button", { name: "发送测试" }).click();

            await expect(playgroundSection.getByText("fake provider response")).toBeVisible();
            await expect(playgroundSection.getByText(/playground_/)).toBeVisible();
            await expect(
              playgroundSection.getByText("Playground OpenAI / GPT 4.1 Nano").first(),
            ).toBeVisible();
            await expect
              .poll(() => readPlaygroundUsageCount(fixture, seeded.virtualModelName))
              .toBe(1);
            expect(provider.requests).toHaveLength(1);

            const browserStorage = await page.evaluate(() => ({
              cookies: document.cookie,
              localStorage: JSON.stringify(localStorage),
              sessionStorage: JSON.stringify(sessionStorage),
            }));
            expect(JSON.stringify(browserStorage)).not.toContain(agentApiKey);

            await page.goto(`${consoleBaseUrl}/usage`);
            await expect(
              page
                .getByLabel("Usage")
                .locator(".stat-card", { hasText: "Total requests" })
                .locator(".stat-card-value"),
            ).toHaveText("1");
            await page.goto(`${consoleBaseUrl}/playground`);
            await expect(page.getByLabel("Playground").getByLabel(/Agent API Key/)).toHaveValue("");
          } finally {
            await context.close();
          }
        } finally {
          await stopConsoleProcess(consoleApp);
        }
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

type ConsoleProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type SeededPlaygroundRoute = {
  virtualModelName: string;
};

async function seedPlaygroundRoute(
  fixture: Fixture,
  input: { agentApiKey: string; providerBaseUrl: string },
): Promise<SeededPlaygroundRoute> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const virtualModelName = "playground-live";
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Playground OpenAI', $2, true)
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
      values ($1, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, $2, 'Playground Live', true)
    `,
    [virtualModelId, virtualModelName],
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
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Playground Agent', 'coding', true)",
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
    "insert into config_versions (version, source, description) values (1, 'console', 'Playground config')",
  );

  return { virtualModelName };
}

async function readPlaygroundUsageCount(
  fixture: Fixture,
  virtualModelName: string,
): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from request_usage
      join request_activity on request_activity.id = request_usage.request_activity_id
      join virtual_models on virtual_models.id = request_activity.virtual_model_id
      where virtual_models.name = $1
    `,
    [virtualModelName],
  );
  return result.rows[0]?.count ?? 0;
}

async function signInFromFirstRun(page: Page, baseUrl: string) {
  const password = "correct horse battery staple";

  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "First run setup" })).toBeVisible();
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
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

async function waitForConsole(baseUrl: string, consoleApp: ConsoleProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (consoleApp.child.exitCode !== null) {
          return `exited:${consoleApp.child.exitCode}`;
        }

        try {
          const response = await fetch(baseUrl);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      {
        message: `Console did not start.\nstdout=${consoleApp.stdout.join("")}\nstderr=${consoleApp.stderr.join("")}`,
        timeout: 15_000,
      },
    )
    .toBe(200);
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

function startConsoleProcess(options: {
  databaseUrl: string;
  gatewayBaseUrl: string;
  port: number;
}): ConsoleProcess {
  const child = spawn(
    "pnpm",
    ["--filter", "@llmingress/console", "exec", "tsx", "src/main.ts", "dev"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONSOLE_PORT: String(options.port),
        DATABASE_URL: options.databaseUrl,
        GATEWAY_PUBLIC_BASE_URL: options.gatewayBaseUrl,
        MASTER_KEY: masterKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const consoleApp: ConsoleProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => consoleApp.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => consoleApp.stdout.push(String(chunk)));
  return consoleApp;
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

async function stopConsoleProcess(consoleApp: ConsoleProcess): Promise<void> {
  if (consoleApp.child.exitCode !== null) {
    return;
  }

  consoleApp.child.kill("SIGTERM");
  await waitForExitOrKill(consoleApp.child);
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  gateway.child.kill("SIGTERM");
  await waitForExitOrKill(gateway.child);
}

async function waitForExitOrKill(child: ChildProcessWithoutNullStreams): Promise<void> {
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
