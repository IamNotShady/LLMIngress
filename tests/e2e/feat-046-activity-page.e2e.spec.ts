import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("activity page lists request and detail shows model cost route fallback error", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_activity_page_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedActivityPageData(fixture);

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
          await page.goto(`${baseUrl}/activity`);

          await expect(page.getByRole("heading", { exact: true, name: "Activity" })).toBeVisible();
          await expect(page.getByRole("link", { name: "req_console_success_046" })).toBeVisible();
          await expect(page.getByRole("link", { name: "req_console_failure_046" })).toBeVisible();
          const activitySection = page.getByLabel("Activity");
          const detail = activitySection.locator(".detail-panel");

          await page.getByRole("link", { name: "req_console_success_046" }).click();
          await expect(detail.getByText("req_console_success_046")).toBeVisible();
          await expect(detail.getByText("Console OpenAI")).toBeVisible();
          await expect(detail.getByText("GPT 4.1 Nano (gpt-4.1-nano)")).toBeVisible();
          await expect(detail.getByText("$0.00004050")).toBeVisible();
          // protocol + HTTP status now read from the request metadata block.
          await expect(detail.getByText(/http_status: 200/)).toBeVisible();
          await expect(
            detail.getByText("cost_first route selected cheapest eligible candidate 2."),
          ).toBeVisible();
          await expect(
            detail.getByText(
              `Attempt 1: provider_request_failed before first byte on ${seeded.primaryProviderModelId}`,
            ),
          ).toBeVisible();

          await page.getByRole("link", { name: "req_console_failure_046" }).click();
          await expect(detail.getByText("req_console_failure_046")).toBeVisible();
          await expect(detail.getByText(/http_status: 502/)).toBeVisible();
          await expect(detail.getByText("Error: provider_request_failed")).toBeVisible();
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

type SeededActivityPageData = {
  primaryProviderModelId: string;
};

async function seedActivityPageData(fixture: Fixture): Promise<SeededActivityPageData> {
  const providerId = randomUUID();
  const primaryProviderModelId = randomUUID();
  const selectedProviderModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const successActivityId = randomUUID();
  const failureActivityId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Console OpenAI', 'https://provider.example/v1', true)
    `,
    [providerId],
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
      values ($1, $2, 'gpt-4.1', 'GPT 4.1', 128000, true, true, 'available'),
             ($3, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 128000, true, true, 'available')
    `,
    [primaryProviderModelId, providerId, selectedProviderModelId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'activity-console', 'Activity Console', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'cost_first')
    `,
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
      values ($1, $2, $3, 1),
             ($4, $2, $5, 2)
    `,
    [randomUUID(), routePolicyId, primaryProviderModelId, randomUUID(), selectedProviderModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Activity Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'activity046', key_hash = 'hash-activity-046', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, virtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        route_policy_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        route_reason,
        fallback_attempts,
        status,
        http_status,
        latency_ms,
        started_at,
        completed_at
      )
      values (
        $1,
        'req_console_success_046',
        $2,
        $3,
        $4,
        $5,
        $6,
        'activity046',
        'chat_completions',
        'activity-console',
        false,
        $7::jsonb,
        $8::jsonb,
        'succeeded',
        200,
        37,
        '2026-06-23T10:00:00.000Z',
        '2026-06-23T10:00:00.037Z'
      ),
      (
        $9,
        'req_console_failure_046',
        $2,
        $3,
        $4,
        $5,
        $6,
        'activity046',
        'chat_completions',
        'activity-console',
        false,
        '{}'::jsonb,
        '[]'::jsonb,
        'failed',
        502,
        12,
        '2026-06-23T10:01:00.000Z',
        '2026-06-23T10:01:00.012Z'
      )
    `,
    [
      successActivityId,
      agentApiKeyId,
      virtualModelId,
      routePolicyId,
      providerId,
      selectedProviderModelId,
      JSON.stringify({
        message: "cost_first route selected cheapest eligible candidate 2.",
        selectedCandidateOrder: 2,
        strategy: "cost_first",
      }),
      JSON.stringify([
        {
          attemptOrder: 1,
          errorCode: "provider_request_failed",
          errorMessage: "network failed before first byte",
          failedBeforeFirstByte: true,
          providerModelId: primaryProviderModelId,
        },
      ]),
      failureActivityId,
    ],
  );
  await fixture.query(
    `
      update request_activity
      set error_code = 'provider_request_failed',
          error_message = 'Provider request failed.'
      where id = $1
    `,
    [failureActivityId],
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
      values ($1, $2, $3, $4, $5, 5, 100, 105, 'estimated')
    `,
    [randomUUID(), successActivityId, agentApiKeyId, virtualModelId, selectedProviderModelId],
  );
  await fixture.query(
    `
      insert into request_costs (
        id,
        request_activity_id,
        agent_id,
        provider_model_id,
        input_cost_usd,
        output_cost_usd,
        total_cost_usd,
        cost_source,
        price_source,
        price_version,
        baseline_provider_model_id,
        actual_cost_usd,
        baseline_cost_usd,
        savings_usd,
        savings_percent,
        savings_price_source,
        savings_price_version
      )
      values (
        $1,
        $2,
        $3,
        $4,
        0.00000050,
        0.00004000,
        0.00004050,
        'estimated',
        'built_in_static_snapshot',
        'mvp-static-2026-06-13',
        $5,
        0.00004050,
        0.00081000,
        0.00076950,
        95.000000,
        'built_in_static_snapshot',
        'mvp-static-2026-06-13'
      )
    `,
    [
      randomUUID(),
      successActivityId,
      agentApiKeyId,
      selectedProviderModelId,
      primaryProviderModelId,
    ],
  );

  return { primaryProviderModelId };
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
