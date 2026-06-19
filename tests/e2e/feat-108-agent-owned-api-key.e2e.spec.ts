import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

const masterKey = "test-master-key";
const providerApiKey = "sk-agent-owned-provider-108";

test("agent creation returns one api key and gateway uses agent owned auth", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_owned_key_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedProviderRoute(fixture, `${provider.url}/v1`);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const consoleBaseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(consoleBaseUrl, consoleApp);
          await signInFromFirstRun(page, consoleBaseUrl);
          await page.goto(`${consoleBaseUrl}/agents`);

          await openDisclosure(page, "New agent");
          await page.getByLabel("Agent name").fill("Agent Owned Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
          const agentApiKey = await page.locator("code").innerText();
          expect(agentApiKey).toMatch(/^llmi_[A-Za-z0-9_-]{32,}$/);

          await expect(readAgentCredentialRows(fixture, agentApiKey)).resolves.toEqual([
            {
              key_hash_contains_plaintext: false,
              key_prefix: agentApiKey.slice(0, 12),
              legacy_key_tables: "absent",
            },
          ]);

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(agentApiKey)).toHaveCount(0);
          await openRow(page, "Agent Owned Codex");
          await expect(
            page.getByText(`Agent API key prefix: ${agentApiKey.slice(0, 12)}`),
          ).toBeVisible();

          const virtualModelLabel = `${seeded.virtualModelDisplayName} (${seeded.virtualModelName})`;
          await page
            .getByLabel("Allowed virtual models")
            .selectOption({ label: virtualModelLabel });
          await page.getByLabel("Default virtual model").selectOption({ label: virtualModelLabel });
          await page.getByRole("button", { name: "Save Agent virtual models" }).click();
          await openRow(page, "Agent Owned Codex");
          await expect(page.getByText(`Default Virtual Model: ${virtualModelLabel}`)).toBeVisible();

          await page.getByLabel("RPM limit").fill("1");
          await page.getByLabel("Budget USD limit").fill("100");
          await page.getByLabel("Budget period").selectOption("month");
          await page.getByLabel("TPM limit").fill("120000");
          await page.getByLabel("Token limit").fill("12000");
          await page.getByRole("button", { name: "Save Agent limits" }).click();
          await openRow(page, "Agent Owned Codex");
          await expect(page.getByText("RPM Limit: 1 requests / minute")).toBeVisible();

          const gateway = startGatewayProcess({
            databaseUrl: fixture.databaseUrl,
            port: await getFreePort(),
          });

          try {
            const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`;
            await waitForGateway(gatewayBaseUrl, gateway);
            await expectAllowedModels(gatewayBaseUrl, agentApiKey, [seeded.virtualModelName]);
            await expectGatewayChat(gatewayBaseUrl, {
              agentApiKey,
              requestId: "req_agent_owned_108_first",
              status: 200,
            });
            await expectGatewayChat(gatewayBaseUrl, {
              agentApiKey,
              expectedCode: "rate_limit_exceeded",
              requestId: "req_agent_owned_108_second",
              status: 429,
            });
          } finally {
            await stopGatewayProcess(gateway);
          }
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
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

type GatewayProcess = ConsoleProcess;

type SeededRoute = {
  virtualModelDisplayName: string;
  virtualModelName: string;
};

async function seedProviderRoute(fixture: Fixture, providerBaseUrl: string): Promise<SeededRoute> {
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
      values ($1, 'api_key', 'agent-owned-provider-108', 'Agent Owned Provider 108', $2, true)
    `,
    [providerId, providerBaseUrl],
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
        availability,
        manual_input_usd_per_million_tokens,
        manual_output_usd_per_million_tokens,
        manual_price_updated_at
      )
      values ($1, $2, 'gpt-agent-owned-108', 'GPT Agent Owned 108', 128000, true, true, 'available', 0.1, 0.2, now())
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, 'agent-owned-model-108', 'Agent Owned Model 108', true)",
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
    "insert into config_versions (version, source, description) values (1, 'console', 'Agent owned key route')",
  );

  return {
    virtualModelDisplayName: "Agent Owned Model 108",
    virtualModelName: "agent-owned-model-108",
  };
}

async function readAgentCredentialRows(
  fixture: Fixture,
  plaintext: string,
): Promise<
  Array<{
    key_hash_contains_plaintext: boolean;
    key_prefix: string;
    legacy_key_tables: "absent" | "present";
  }>
> {
  const result = await fixture.query<{
    key_hash_contains_plaintext: boolean;
    key_prefix: string;
    legacy_key_tables: "absent" | "present";
  }>(
    `
      select key_prefix,
             key_hash like $1 as key_hash_contains_plaintext,
             case
               when to_regclass('agent_api_keys') is null
                and to_regclass('agent_api_key_virtual_models') is null
               then 'absent'
               else 'present'
             end as legacy_key_tables
      from agents
      where name = 'Agent Owned Codex'
    `,
    [`%${plaintext}%`],
  );
  return result.rows;
}

async function expectAllowedModels(
  baseUrl: string,
  agentApiKey: string,
  expectedModelNames: string[],
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${agentApiKey}`, "x-request-id": "req_models_108" },
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    data: expectedModelNames.map((modelName) => ({ id: modelName, object: "model" })),
    object: "list",
    requestId: "req_models_108",
  });
}

async function expectGatewayChat(
  baseUrl: string,
  input: {
    agentApiKey: string;
    expectedCode?: string;
    requestId: string;
    status: 200 | 429;
  },
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 32,
      messages: [{ content: "hello", role: "user" }],
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(input.status);
  const body = await response.json();
  if (input.status === 200) {
    expect(body).toMatchObject({
      choices: [{ message: { content: "fake provider response" } }],
    });
  } else {
    expect(body).toMatchObject({ error: { code: input.expectedCode } });
  }
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
          return `exited:${consoleApp.child.exitCode}\nstdout=${consoleApp.stdout.join("")}\nstderr=${consoleApp.stderr.join("")}`;
        }
        try {
          const response = await fetch(baseUrl);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      { message: "Console did not start.", timeout: 15_000 },
    )
    .toBe(200);
}

async function waitForGateway(baseUrl: string, gateway: GatewayProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (gateway.child.exitCode !== null) {
          return `exited:${gateway.child.exitCode}\nstdout=${gateway.stdout.join("")}\nstderr=${gateway.stderr.join("")}`;
        }
        try {
          const response = await fetch(`${baseUrl}/health`);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      { message: "Gateway did not start.", timeout: 15_000 },
    )
    .toBe(200);
}

function startConsoleProcess(options: { databaseUrl: string; port: number }): ConsoleProcess {
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
  const consoleApp = { child, port: options.port, stderr: [], stdout: [] };
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
  const gateway = { child, port: options.port, stderr: [], stdout: [] };
  child.stderr.on("data", (chunk) => gateway.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => gateway.stdout.push(String(chunk)));
  return gateway;
}

async function stopConsoleProcess(consoleApp: ConsoleProcess): Promise<void> {
  await stopProcess(consoleApp);
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  await stopProcess(gateway);
}

async function stopProcess(processInfo: ConsoleProcess): Promise<void> {
  if (processInfo.child.exitCode !== null) {
    return;
  }
  processInfo.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    processInfo.child.once("exit", () => resolve());
    setTimeout(() => {
      if (processInfo.child.exitCode === null) {
        processInfo.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
