import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("agent key limit form saves budget rpm tpm token rules and blocks cost budget when selected model has unknown price", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_limits_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://127.0.0.1:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);

          await page.getByLabel("Agent name").fill("Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Codex" })).toBeVisible();

          await page.getByRole("button", { name: "Create Agent API key" }).click();
          await expect(page.getByRole("heading", { name: "Agent API key created" })).toBeVisible();
          await page.getByRole("link", { name: "Back to dashboard" }).click();

          const apiKeyId = await readOnlyAgentApiKeyId(fixture);

          await expect(page.getByLabel("Budget USD limit")).toBeVisible({ timeout: 3_000 });
          const unknownModelId = "unknown-budget-model";
          await expect(
            postLimitRules(page, {
              apiKeyId,
              budgetPriceModelId: unknownModelId,
              budgetPriceProviderKey: "openai",
              budgetUsd: "10",
              rpm: "60",
              tokenLimit: "8000",
              tpm: "120000",
            }),
          ).resolves.toEqual({
            body: { error: expect.stringMatching(/unknown price/i) },
            status: 400,
          });
          await expect.poll(() => countAgentLimits(fixture)).toBe(0);

          await saveManualPriceOverride(page, {
            inputUsdPerMillionTokens: "1",
            modelId: unknownModelId,
            outputUsdPerMillionTokens: "2",
            providerKey: "openai",
          });

          await page.getByLabel("Budget USD limit").fill("10");
          await page.getByLabel("Budget period").selectOption("month");
          await page.getByLabel("Budget price provider key").fill("openai");
          await page.getByLabel("Budget price model id").fill(unknownModelId);
          await page.getByLabel("RPM limit").fill("60");
          await page.getByLabel("TPM limit").fill("120000");
          await page.getByLabel("Token limit").fill("8000");
          await page.getByRole("button", { name: "Save Agent API key limits" }).click();

          await expect(page.getByText("Budget Limit: $10.00 / month")).toBeVisible();
          await expect(page.getByText("RPM Limit: 60 requests / minute")).toBeVisible();
          await expect(page.getByText("TPM Limit: 120000 tokens / minute")).toBeVisible();
          await expect(page.getByText("Token Limit: 8000 tokens / request")).toBeVisible();
          await expect
            .poll(() => readAgentLimits(fixture))
            .toEqual([
              { limitType: "budget", limitValue: "10.000000", period: "month", unit: "usd" },
              { limitType: "rpm", limitValue: "60.000000", period: "minute", unit: "requests" },
              { limitType: "token", limitValue: "8000.000000", period: "request", unit: "tokens" },
              { limitType: "tpm", limitValue: "120000.000000", period: "minute", unit: "tokens" },
            ]);
          await expect.poll(() => countAgentLimitConfigChanges(fixture)).toBe(1);
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

type AgentLimitRow = {
  limit_type: string;
  limit_value: string;
  period: string;
  unit: string;
};

async function readOnlyAgentApiKeyId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>("select id::text from agent_api_keys");
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Expected exactly one Agent API key.");
  }
  return row.id;
}

async function postLimitRules(
  page: Page,
  input: {
    apiKeyId: string;
    budgetPriceModelId: string;
    budgetPriceProviderKey: string;
    budgetUsd: string;
    rpm: string;
    tokenLimit: string;
    tpm: string;
  },
) {
  return page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", "saveLimitRules");
    body.set("agentApiKeyId", payload.apiKeyId);
    body.set("budgetPeriod", "month");
    body.set("budgetPriceProviderKey", payload.budgetPriceProviderKey);
    body.set("budgetPriceModelId", payload.budgetPriceModelId);
    body.set("budgetUsd", payload.budgetUsd);
    body.set("rpm", payload.rpm);
    body.set("tpm", payload.tpm);
    body.set("tokenLimit", payload.tokenLimit);

    const response = await fetch("/api/agent-limits", { body, method: "POST" });
    return {
      body: await response.json(),
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

async function countAgentLimits(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from agent_limits",
  );
  return result.rows[0]?.count ?? 0;
}

async function readAgentLimits(fixture: Fixture) {
  const result = await fixture.query<AgentLimitRow>(
    `
      select limit_type,
             period,
             limit_value::text,
             unit
      from agent_limits
      order by limit_type
    `,
  );
  return result.rows.map((row) => ({
    limitType: row.limit_type,
    limitValue: row.limit_value,
    period: row.period,
    unit: row.unit,
  }));
}

async function countAgentLimitConfigChanges(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from config_change_events
      where source = 'console'
        and changed_table = 'agent_limits'
    `,
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
