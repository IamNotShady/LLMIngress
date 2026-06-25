import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("budget enabled agent cannot save route policy with unknown price provider model", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_budget_safe_route_${randomUUID().replaceAll("-", "_")}`,
  });
  const seededProviderModel = {
    id: randomUUID(),
    modelId: "unknown-budget-model",
  };

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedUnknownProviderModel(fixture, seededProviderModel.id);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);

          await page.goto(`${baseUrl}/models`);
          await createVirtualModel(page);
          await page.goto(`${baseUrl}/agents`);
          await createAgentApiKey(page);
          const virtualModelId = await readVirtualModelId(fixture);
          const apiKeyId = await readOnlyAgentApiKeyId(fixture);

          await assignVirtualModelAccess(page);
          await saveKnownPriceCostBudget(page);

          await expect(
            postRoutePolicy(page, {
              primaryProviderModelId: seededProviderModel.id,
              virtualModelId,
            }),
          ).resolves.toEqual({
            body: {
              error: expect.stringMatching(
                /Unknown Budget Model.*unknown price.*manual price override.*priced replacement/i,
              ),
            },
            status: 400,
          });
          await expect.poll(() => countRoutePolicies(fixture)).toBe(0);
          await expect.poll(() => countRoutePolicyConfigChanges(fixture)).toBe(0);

          await saveManualPriceOverride(page, {
            inputUsdPerMillionTokens: "1.25",
            modelId: seededProviderModel.modelId,
            outputUsdPerMillionTokens: "5.50",
            providerKey: "openai",
          });

          await page.goto(`${baseUrl}/agents`);
          await openRow(page, "Budget Agent");
          await expect(
            page.getByLabel("Default virtual model").locator("option:checked"),
          ).toHaveText("Budget Safe VM (budget-safe-vm)");
          await expect(
            postRoutePolicy(page, {
              primaryProviderModelId: seededProviderModel.id,
              virtualModelId,
            }),
          ).resolves.toEqual({
            body: null,
            status: 200,
          });
          await expect.poll(() => countRoutePolicies(fixture)).toBe(1);
          await expect.poll(() => countBudgetLimitRows(fixture, apiKeyId)).toBe(1);
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
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

async function seedUnknownProviderModel(fixture: Fixture, providerModelId: string): Promise<void> {
  const providerId = randomUUID();
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Budget Safe Provider', 'https://api.openai.com/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'unknown-budget-model', 'Unknown Budget Model', 'available')
    `,
    [providerModelId, providerId],
  );
}

async function createVirtualModel(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const body = new FormData();
    body.set("action", "create");
    body.set("name", "budget-safe-vm");
    body.set("description", "Budget Safe VM");
    const response = await fetch("/api/virtual-models", { body, method: "POST" });
    return { status: response.status, text: await response.text() };
  });
  expect(result.status, result.text).toBe(200);
}

async function createAgentApiKey(page: Page): Promise<void> {
  await openDisclosure(page, "New agent");
  await page.getByLabel("Agent name").fill("Budget Agent");
  await page.getByLabel("Agent type").selectOption("coding");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
}

async function assignVirtualModelAccess(page: Page): Promise<void> {
  const label = "Budget Safe VM (budget-safe-vm)";
  await openRow(page, "Budget Agent");
  await page.getByLabel("Allowed virtual models").selectOption({ label });
  await page.getByLabel("Default virtual model").selectOption({ label });
  await page.getByRole("button", { name: "Save" }).click();
  await openRow(page, "Budget Agent");
  await expect(page.getByLabel("Default virtual model").locator("option:checked")).toHaveText(
    label,
  );
}

async function saveKnownPriceCostBudget(page: Page): Promise<void> {
  await openRow(page, "Budget Agent");
  await page.getByLabel("Budget USD limit").fill("10");
  await page.getByLabel("Budget period").selectOption("month");
  await page.getByLabel("RPM limit").fill("60");
  await page.getByLabel("TPM limit").fill("120000");
  await page.getByLabel("Token limit").fill("8000");
  await page.getByRole("button", { name: "Save" }).click();
  await openRow(page, "Budget Agent");
  await expect(page.getByLabel("Budget USD limit")).toHaveValue("10");
}

async function postRoutePolicy(
  page: Page,
  input: {
    primaryProviderModelId: string;
    virtualModelId: string;
  },
) {
  return page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", "create");
    body.set("virtualModelId", payload.virtualModelId);
    body.set("strategy", "fixed");
    body.append("primaryProviderModelIds", payload.primaryProviderModelId);

    const response = await fetch("/api/route-policies", {
      body,
      method: "POST",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = contentType.includes("application/json") ? await response.text() : "";
    return {
      body: text ? JSON.parse(text) : null,
      status: response.status,
    };
  }, input);
}

async function saveManualPriceOverride(
  page: Page,
  input: {
    inputUsdPerMillionTokens: string;
    modelId: string;
    outputUsdPerMillionTokens: string;
    providerKey: string;
  },
): Promise<void> {
  await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("providerKey", payload.providerKey);
    body.set("modelId", payload.modelId);
    body.set("inputUsdPerMillionTokens", payload.inputUsdPerMillionTokens);
    body.set("outputUsdPerMillionTokens", payload.outputUsdPerMillionTokens);

    const response = await fetch("/api/prices/override", { body, method: "POST" });
    if (!response.ok) {
      throw new Error(`Manual price override failed with HTTP ${response.status}.`);
    }
  }, input);
}

async function readVirtualModelId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text from virtual_models where name = 'budget-safe-vm'",
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected Budget Safe VM to exist.");
  }
  return row.id;
}

async function readOnlyAgentApiKeyId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>("select id::text from agents");
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Expected exactly one Agent API key.");
  }
  return row.id;
}

async function countRoutePolicies(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from route_policies",
  );
  return result.rows[0]?.count ?? 0;
}

async function countRoutePolicyConfigChanges(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from config_versions
      cross join lateral jsonb_array_elements(config_versions.changes) as change(value)
      where change.value->>'table' = 'route_policies'
    `,
  );
  return result.rows[0]?.count ?? 0;
}

async function countBudgetLimitRows(fixture: Fixture, agentApiKeyId: string): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from agent_limits
      where agent_id = $1
        and limit_type = 'budget'
        and enabled = true
    `,
    [agentApiKeyId],
  );
  return result.rows[0]?.count ?? 0;
}

async function signInFromFirstRun(page: Page, baseUrl: string): Promise<void> {
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
  let lastObservedStatus = "not-started";

  await expect
    .poll(
      async () => {
        if (consoleApp.child.exitCode !== null) {
          return [
            `exited:${consoleApp.child.exitCode}`,
            `last:${lastObservedStatus}`,
            `stdout:${consoleApp.stdout.join("")}`,
            `stderr:${consoleApp.stderr.join("")}`,
          ].join("\n");
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
        timeout: 15_000,
      },
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
        MASTER_KEY: "test-master-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return captureProcess(child, { port: options.port });
}

function captureProcess<T extends object>(
  child: ChildProcessWithoutNullStreams,
  extra: T,
): ConsoleProcess & T {
  const app = {
    ...extra,
    child,
    stderr: [],
    stdout: [],
  } as ConsoleProcess & T;
  child.stderr.on("data", (chunk) => app.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => app.stdout.push(String(chunk)));
  return app;
}

async function stopConsoleProcess(consoleApp: ConsoleProcess): Promise<void> {
  if (consoleApp.child.exitCode !== null) {
    return;
  }

  consoleApp.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    consoleApp.child.once("exit", () => resolve());
    setTimeout(() => {
      if (consoleApp.child.exitCode === null) {
        consoleApp.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
