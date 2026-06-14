import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("route policy CRUD persists candidates cost preference and fallback chain", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_route_policy_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seededModels = await seedProviderModels(fixture);

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

          await page.getByRole("textbox", { name: "Virtual model name" }).fill("Coding Fast");
          await page
            .getByRole("textbox", { name: "Virtual model display name" })
            .fill("Coding Fast");
          await page.getByRole("button", { name: "Create virtual model" }).click();
          await expect(page.getByRole("heading", { name: "Coding Fast" })).toBeVisible();

          await page
            .getByLabel("Route policy virtual model")
            .selectOption({ label: "Coding Fast (coding-fast)" });
          await page.getByLabel("Route policy strategy").selectOption("balanced");
          await page
            .getByLabel("Primary provider models")
            .selectOption({ label: seededModels.openai.optionLabel });
          await page
            .getByLabel("Fallback provider models")
            .selectOption({ label: seededModels.anthropic.optionLabel });
          await page.getByRole("button", { name: "Create route policy" }).click();

          await expect(
            page.getByRole("heading", { name: "Route policy", exact: true }),
          ).toBeVisible();
          await expect(page.getByText("Virtual Model: Coding Fast (coding-fast)")).toBeVisible();
          await expect(page.getByText("Strategy: balanced")).toBeVisible();
          await expect(
            page.getByText(
              "Route reason: balanced route for coding-fast uses 1 primary candidate with 1 fallback.",
            ),
          ).toBeVisible();
          await expect(page.getByText(`Primary: ${seededModels.openai.optionLabel}`)).toBeVisible();
          await expect(
            page.getByText(`Fallback: ${seededModels.anthropic.optionLabel}`),
          ).toBeVisible();

          await expect
            .poll(() => readRoutePolicyState(fixture))
            .toEqual({
              candidates: [
                {
                  candidateOrder: 1,
                  isFallback: false,
                  providerModelId: seededModels.openai.id,
                },
                {
                  candidateOrder: 2,
                  isFallback: true,
                  providerModelId: seededModels.anthropic.id,
                },
              ],
              strategy: "balanced",
              virtualModelName: "coding-fast",
            });

          await page.getByLabel("Edit route policy strategy").selectOption("quality_first");
          await page
            .getByLabel("Edit primary provider models")
            .selectOption({ label: seededModels.anthropic.optionLabel });
          await page
            .getByLabel("Edit fallback provider models")
            .selectOption({ label: seededModels.openai.optionLabel });
          await page.getByRole("button", { name: "Save route policy" }).click();

          await expect(page.getByText("Strategy: quality_first")).toBeVisible();
          await expect(
            page.getByText(
              "Route reason: quality_first route for coding-fast uses 1 primary candidate with 1 fallback.",
            ),
          ).toBeVisible();
          await expect
            .poll(() => readRoutePolicyState(fixture))
            .toEqual({
              candidates: [
                {
                  candidateOrder: 1,
                  isFallback: false,
                  providerModelId: seededModels.anthropic.id,
                },
                {
                  candidateOrder: 2,
                  isFallback: true,
                  providerModelId: seededModels.openai.id,
                },
              ],
              strategy: "quality_first",
              virtualModelName: "coding-fast",
            });

          await page.getByRole("button", { name: "Delete route policy" }).click();
          await expect(page.getByText("No route policies configured.")).toBeVisible();
          await expect.poll(() => countRoutePolicies(fixture)).toBe(0);
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

type SeededModel = {
  id: string;
  optionLabel: string;
};

type RoutePolicyState = {
  candidates: Array<{
    candidateOrder: number;
    isFallback: boolean;
    providerModelId: string;
  }>;
  strategy: string;
  virtualModelName: string;
};

async function seedProviderModels(fixture: Fixture): Promise<{
  anthropic: SeededModel;
  openai: SeededModel;
}> {
  const openaiProviderId = randomUUID();
  const anthropicProviderId = randomUUID();
  const openaiModelId = randomUUID();
  const anthropicModelId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', 'https://api.openai.com/v1', true),
             ($2, 'api_key', 'anthropic', 'Anthropic', 'https://api.anthropic.com/v1', true)
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
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 128000, true, true, 'available'),
             ($3, $4, 'claude-sonnet-4', 'Claude Sonnet 4', 200000, true, true, 'available')
    `,
    [openaiModelId, openaiProviderId, anthropicModelId, anthropicProviderId],
  );

  return {
    anthropic: {
      id: anthropicModelId,
      optionLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4)",
    },
    openai: {
      id: openaiModelId,
      optionLabel: "OpenAI - GPT 4.1 Mini (gpt-4.1-mini)",
    },
  };
}

async function readRoutePolicyState(fixture: Fixture): Promise<RoutePolicyState> {
  const policy = await fixture.query<{
    strategy: string;
    virtual_model_name: string;
  }>(
    `
      select route_policies.strategy,
             virtual_models.name as virtual_model_name
      from route_policies
      join virtual_models on virtual_models.id = route_policies.virtual_model_id
    `,
  );
  const candidates = await fixture.query<{
    candidate_order: number;
    is_fallback: boolean;
    provider_model_id: string;
  }>(
    `
      select provider_model_id::text,
             candidate_order,
             is_fallback
      from route_policy_candidates
      order by candidate_order
    `,
  );
  const policyRow = policy.rows[0];
  if (!policyRow) {
    throw new Error("Route policy was not found.");
  }

  return {
    candidates: candidates.rows.map((row) => ({
      candidateOrder: row.candidate_order,
      isFallback: row.is_fallback,
      providerModelId: row.provider_model_id,
    })),
    strategy: policyRow.strategy,
    virtualModelName: policyRow.virtual_model_name,
  };
}

async function countRoutePolicies(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from route_policies",
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
