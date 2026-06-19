import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("usage page shows agent virtual model provider model cost failure and savings breakdowns", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_usage_breakdowns_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedUsageBreakdownData(fixture);

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
          await page.goto(`${baseUrl}/usage`);

          const usageSection = page.getByRole("region", { name: "Usage & Cost" });
          // Counts + savings via the KPI cards and the savings panel.
          await expect(
            usageSection
              .locator(".stat-card", { hasText: "Total requests" })
              .locator(".stat-card-value"),
          ).toHaveText("3");
          await expect(
            usageSection.locator(".stat-card", { hasText: "Savings" }).locator(".stat-card-value"),
          ).toHaveText("$0.00400000");

          // Cost breakdown donuts surface agent / virtual model / provider names in their legends.
          await expect(usageSection.getByRole("heading", { name: "Agent cost" })).toBeVisible();
          await expect(usageSection.getByText("Codex Usage", { exact: true })).toBeVisible();
          await expect(
            usageSection.getByRole("heading", { name: "Virtual Model cost" }),
          ).toBeVisible();
          await expect(
            usageSection.getByText("Usage Fast (usage-fast)", { exact: true }),
          ).toBeVisible();
          await expect(usageSection.getByRole("heading", { name: "Provider cost" })).toBeVisible();
          await expect(
            usageSection.getByText("Usage OpenAI", { exact: true }).first(),
          ).toBeVisible();
          await expect(
            usageSection.getByText("Usage Anthropic", { exact: true }).first(),
          ).toBeVisible();

          // Provider / Model summary table lists each provider+model row.
          await expect(
            usageSection.getByRole("heading", { name: "Provider / Model summary" }),
          ).toBeVisible();
          await expect(usageSection.getByRole("cell", { name: /GPT 4\.1 Mini/ })).toBeVisible();
          await expect(usageSection.getByRole("cell", { name: /Claude Haiku/ })).toBeVisible();
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

async function seedUsageBreakdownData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    anthropicModelId: randomUUID(),
    anthropicProviderId: randomUUID(),
    openaiModelId: randomUUID(),
    openaiProviderId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Usage OpenAI', 'https://openai.example/v1', true),
             ($2, 'api_key', 'anthropic', 'Usage Anthropic', 'https://anthropic.example/v1', true)
    `,
    [ids.openaiProviderId, ids.anthropicProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 'available'),
             ($3, $4, 'claude-haiku-4-5', 'Claude Haiku', 'available')
    `,
    [ids.openaiModelId, ids.openaiProviderId, ids.anthropicModelId, ids.anthropicProviderId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, 'usage-fast', 'Usage Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Codex Usage', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_usage79', key_hash = 'hash-usage-079', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );

  await insertUsageBreakdownRequest(fixture, {
    ...ids,
    costUsd: "0.00050000",
    inputTokens: 50,
    outputTokens: 100,
    providerId: ids.openaiProviderId,
    providerModelId: ids.openaiModelId,
    requestId: "req_usage_breakdown_openai_079",
    savingsUsd: "0.00200000",
    status: "succeeded",
  });
  await insertUsageBreakdownRequest(fixture, {
    ...ids,
    costUsd: "0.00100000",
    inputTokens: 100,
    outputTokens: 200,
    providerId: ids.anthropicProviderId,
    providerModelId: ids.anthropicModelId,
    requestId: "req_usage_breakdown_anthropic_079",
    savingsUsd: "0.00200000",
    status: "succeeded",
  });
  await insertUsageBreakdownRequest(fixture, {
    ...ids,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    providerId: null,
    providerModelId: null,
    requestId: "req_usage_breakdown_failed_079",
    savingsUsd: null,
    status: "failed",
  });
}

async function insertUsageBreakdownRequest(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    costUsd: string | null;
    inputTokens: number;
    outputTokens: number;
    providerId: string | null;
    providerModelId: string | null;
    requestId: string;
    savingsUsd: string | null;
    status: "failed" | "succeeded";
    virtualModelId: string;
  },
): Promise<void> {
  const activityId = randomUUID();
  const totalTokens = input.inputTokens + input.outputTokens;

  await fixture.query(
    `
      insert into request_activity (
        id, request_id, agent_id, virtual_model_id, provider_id,
        provider_model_id, agent_key_prefix, protocol, model, stream,
        status, error_code, http_status, started_at, completed_at
      )
      values (
        $1, $2, $3, $4, $5, $6, 'llmi_usage79', 'chat_completions', 'usage-fast',
        false, $7, case when $7 = 'failed' then 'provider_error' else null end,
        case when $7 = 'failed' then 502 else 200 end,
        now() - interval '1 hour', now() - interval '59 minutes'
      )
    `,
    [
      activityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerId,
      input.providerModelId,
      input.status,
    ],
  );
  if (input.status === "failed" || !input.providerModelId) {
    return;
  }
  await fixture.query(
    `
      insert into request_usage (
        id, request_activity_id, agent_id, virtual_model_id, provider_model_id,
        input_tokens, output_tokens, total_tokens, token_source
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'estimated')
    `,
    [
      randomUUID(),
      activityId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerModelId,
      input.inputTokens,
      input.outputTokens,
      totalTokens,
    ],
  );
  await fixture.query(
    `
      insert into request_costs (
        id, request_activity_id, agent_id, provider_model_id, total_cost_usd, cost_source
      )
      values ($1, $2, $3, $4, $5::numeric, 'estimated')
    `,
    [randomUUID(), activityId, input.agentApiKeyId, input.providerModelId, input.costUsd],
  );
  await fixture.query(
    `
      insert into request_savings (
        id, request_activity_id, actual_cost_usd, baseline_cost_usd, savings_usd
      )
      values ($1, $2, $3::numeric, ($3::numeric + $4::numeric), $4::numeric)
    `,
    [randomUUID(), activityId, input.costUsd, input.savingsUsd],
  );
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
      { message: "Console did not start.", timeout: 15_000 },
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
