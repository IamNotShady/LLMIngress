import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("usage page shows counts tokens cost and provider model breakdown", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_usage_page_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedUsagePageData(fixture);

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

          await expect(page.getByRole("heading", { name: "Usage & Cost" })).toBeVisible();
          // KPI cards (counts + tokens) and the provider/model summary table.
          await expect(
            page.locator(".stat-card", { hasText: "Total requests" }).locator(".stat-card-value"),
          ).toHaveText("2");
          await expect(
            page.locator(".stat-card", { hasText: "Total tokens" }).locator(".stat-card-value"),
          ).toHaveText("450");
          const summary = page.getByRole("table");
          await expect(
            summary.getByRole("row", { name: /Console OpenAI.*GPT 4\.1 Nano.*150.*\$0\.00050000/ }),
          ).toBeVisible();
          await expect(
            summary.getByRole("row", {
              name: /Console Anthropic.*Claude Haiku.*300.*\$0\.00100000/,
            }),
          ).toBeVisible();

          await page.getByLabel("Window").selectOption("30d");
          await page.getByRole("button", { name: "Apply" }).click();

          await expect(
            page.locator(".stat-card", { hasText: "Total requests" }).locator(".stat-card-value"),
          ).toHaveText("3");
          await expect(
            page.locator(".stat-card", { hasText: "Total tokens" }).locator(".stat-card-value"),
          ).toHaveText("999");
          await expect(page.getByRole("cell", { name: "GPT 4.1", exact: true })).toBeVisible();
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

async function seedUsagePageData(fixture: Fixture): Promise<void> {
  const openaiProviderId = randomUUID();
  const anthropicProviderId = randomUUID();
  const openaiNanoModelId = randomUUID();
  const openaiLargeModelId = randomUUID();
  const anthropicModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Console OpenAI', 'https://openai.example/v1', true),
             ($2, 'api_key', 'anthropic', 'Console Anthropic', 'https://anthropic.example/v1', true)
    `,
    [openaiProviderId, anthropicProviderId],
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
      values ($1, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 128000, true, true, 'available'),
             ($3, $2, 'gpt-4.1', 'GPT 4.1', 128000, true, true, 'available'),
             ($4, $5, 'claude-haiku-4-5', 'Claude Haiku', 200000, true, true, 'available')
    `,
    [
      openaiNanoModelId,
      openaiProviderId,
      openaiLargeModelId,
      anthropicModelId,
      anthropicProviderId,
    ],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'usage-console', 'Usage Console', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'balanced')
    `,
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order, is_fallback)
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), routePolicyId, openaiNanoModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Usage Page Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'usage047', key_hash = 'hash-usage-047', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, virtualModelId],
  );

  await insertUsageRequest(fixture, {
    agentApiKeyId,
    costUsd: "0.00050000",
    inputTokens: 50,
    outputTokens: 100,
    providerId: openaiProviderId,
    providerModelId: openaiNanoModelId,
    requestId: "req_usage_page_openai_047",
    startedAtSql: "now() - interval '1 hour'",
    virtualModelId,
  });
  await insertUsageRequest(fixture, {
    agentApiKeyId,
    costUsd: "0.00100000",
    inputTokens: 100,
    outputTokens: 200,
    providerId: anthropicProviderId,
    providerModelId: anthropicModelId,
    requestId: "req_usage_page_anthropic_047",
    startedAtSql: "now() - interval '2 hours'",
    virtualModelId,
  });
  await insertUsageRequest(fixture, {
    agentApiKeyId,
    costUsd: "0.00123456",
    inputTokens: 99,
    outputTokens: 450,
    providerId: openaiProviderId,
    providerModelId: openaiLargeModelId,
    requestId: "req_usage_page_old_047",
    startedAtSql: "now() - interval '10 days'",
    virtualModelId,
  });
}

async function insertUsageRequest(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    costUsd: string;
    inputTokens: number;
    outputTokens: number;
    providerId: string;
    providerModelId: string;
    requestId: string;
    startedAtSql: string;
    virtualModelId: string;
  },
): Promise<void> {
  const activityId = randomUUID();
  const totalTokens = input.inputTokens + input.outputTokens;

  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        status,
        http_status,
        latency_ms,
        started_at,
        completed_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        'usage047',
        'chat_completions',
        'usage-console',
        false,
        'succeeded',
        200,
        25,
        ${input.startedAtSql},
        ${input.startedAtSql} + interval '25 milliseconds'
      )
    `,
    [
      activityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerId,
      input.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_usage (
        id,
        request_activity_id,
        agent_id,
        virtual_model_id,
        provider_model_id,
        input_tokens,
        output_tokens,
        total_tokens,
        token_source
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
        id,
        request_activity_id,
        agent_id,
        provider_model_id,
        total_cost_usd,
        cost_source,
        price_source,
        price_version
      )
      values ($1, $2, $3, $4, $5::numeric, 'estimated', 'built_in_static_snapshot', 'mvp-static-2026-06-13')
    `,
    [randomUUID(), activityId, input.agentApiKeyId, input.providerModelId, input.costUsd],
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
