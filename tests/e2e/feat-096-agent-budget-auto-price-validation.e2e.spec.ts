import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("agent budget saves without manual price fields and blocks accessible unknown-price route candidates", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_budget_auto_price_${randomUUID().replaceAll("-", "_")}`,
  });
  const seededIds = {
    agentApiKeyId: randomUUID(),
    providerId: randomUUID(),
    routePolicyId: randomUUID(),
    unknownFallbackModelId: randomUUID(),
    unknownPrimaryModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedAgentBudgetRouteGraph(fixture, seededIds);

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

          await page.goto(`${baseUrl}/agents`);
          await expect(
            page
              .getByLabel("Selected agent details")
              .getByRole("heading", { name: "Auto Budget Agent" }),
          ).toBeVisible();
          await openRow(page, "Auto Budget Agent");
          await expect(page.getByLabel("Default virtual model")).toHaveValue(
            seededIds.virtualModelId,
          );
          await expect(page.getByLabel("Allowed virtual models")).toHaveValues([
            seededIds.virtualModelId,
          ]);

          await page.goto(`${baseUrl}/agents`);
          await expect(page.getByLabel("Budget price provider key")).toHaveCount(0);
          await expect(page.getByLabel("Budget price model id")).toHaveCount(0);

          await expect(
            postLimitRules(page, {
              agentApiKeyId: seededIds.agentApiKeyId,
              budgetUsd: "25",
              rpm: "120",
              tokenLimit: "32000",
              tpm: "640000",
            }),
          ).resolves.toEqual({
            body: {
              error: expect.stringMatching(
                /(?=.*Unknown Primary Model)(?=.*Unknown Fallback Model)(?=.*unknown price)(?=.*manual price override)(?=.*sync prices)/i,
              ),
            },
            status: 400,
          });
          await expect.poll(() => countAgentLimits(fixture, seededIds.agentApiKeyId)).toBe(0);
          await expect.poll(() => countAgentLimitConfigChanges(fixture)).toBe(0);

          await saveManualPriceOverride(page, {
            inputUsdPerMillionTokens: "1.25",
            modelId: "unknown-primary-model",
            outputUsdPerMillionTokens: "5.50",
            providerKey: "openai",
          });
          await saveManualPriceOverride(page, {
            inputUsdPerMillionTokens: "0.75",
            modelId: "unknown-fallback-model",
            outputUsdPerMillionTokens: "2.25",
            providerKey: "openai",
          });

          await openRow(page, "Auto Budget Agent");
          await page.getByLabel("Budget USD limit").fill("25");
          await page.getByLabel("Budget period").selectOption("month");
          await page.getByLabel("RPM limit").fill("120");
          await page.getByLabel("TPM limit").fill("640000");
          await page.getByLabel("Token limit").fill("32000");
          await page.getByRole("button", { name: "Save" }).click();

          await openRow(page, "Auto Budget Agent");
          await expect(page.getByLabel("Budget USD limit")).toHaveValue("25");
          await expect(page.getByLabel("Budget period")).toHaveValue("month");
          await expect(page.getByLabel("RPM limit")).toHaveValue("120");
          await expect(page.getByLabel("TPM limit")).toHaveValue("640000");
          await expect(page.getByLabel("Token limit")).toHaveValue("32000");
          await expect.poll(() => countAgentLimits(fixture, seededIds.agentApiKeyId)).toBe(4);
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

type SeededIds = {
  agentApiKeyId: string;
  providerId: string;
  routePolicyId: string;
  unknownFallbackModelId: string;
  unknownPrimaryModelId: string;
  virtualModelId: string;
};

async function seedAgentBudgetRouteGraph(fixture: Fixture, ids: SeededIds): Promise<void> {
  const agentId = ids.agentApiKeyId;

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Auto Budget Provider', 'https://api.openai.com/v1', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $3, 'unknown-primary-model', 'Unknown Primary Model', 'available'),
             ($2, $3, 'unknown-fallback-model', 'Unknown Fallback Model', 'available')
    `,
    [ids.unknownPrimaryModelId, ids.unknownFallbackModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'auto-budget-vm', 'Auto Budget VM', true)
    `,
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [ids.routePolicyId, ids.virtualModelId],
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
      values ($1, $3, $5, 1, false),
             ($2, $3, $4, 2, true)
    `,
    [
      randomUUID(),
      randomUUID(),
      ids.routePolicyId,
      ids.unknownFallbackModelId,
      ids.unknownPrimaryModelId,
    ],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Auto Budget Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_auto96', key_hash = 'sha256:v1:auto-budget-e2e-096', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, agentId, ids.virtualModelId],
  );
  await fixture.query(
    "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
    [ids.agentApiKeyId, ids.virtualModelId],
  );
}

async function postLimitRules(
  page: Page,
  input: {
    agentApiKeyId: string;
    budgetUsd: string;
    rpm: string;
    tokenLimit: string;
    tpm: string;
  },
) {
  return page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", "saveLimitRules");
    body.set("agentApiKeyId", payload.agentApiKeyId);
    body.set("budgetPeriod", "month");
    body.set("budgetUsd", payload.budgetUsd);
    body.set("rpm", payload.rpm);
    body.set("tpm", payload.tpm);
    body.set("tokenLimit", payload.tokenLimit);

    const response = await fetch("/api/agent-limits", {
      body,
      method: "POST",
      redirect: "manual",
    });
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

async function countAgentLimits(fixture: Fixture, agentApiKeyId: string): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from agent_limits
      where agent_id = $1
    `,
    [agentApiKeyId],
  );
  return result.rows[0]?.count ?? 0;
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
