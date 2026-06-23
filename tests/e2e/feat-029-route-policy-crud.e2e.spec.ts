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
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await postVirtualModelAction(page, {
            action: "create",
            description: "Coding Fast",
            name: "coding-fast",
          });
          const virtualModelId = await readVirtualModelId(fixture, "coding-fast");

          await page.goto(`${baseUrl}/models?virtualModelDialog=${virtualModelId}`);
          await page.locator(".vm-add-model-button").click();
          const modelPickerRow = page
            .locator(".vm-model-picker-table tbody tr")
            .filter({ hasText: "GPT 4.1 Mini" });
          await expect(modelPickerRow).toContainText("128K");
          await expect(modelPickerRow.locator("td").nth(5)).toHaveText("Yes");
          await expect(modelPickerRow.locator("td").nth(6)).toHaveText("Yes");

          await postRoutePolicyAction(page, {
            action: "create",
            fallbackProviderModelIds: [seededModels.anthropic.id],
            primaryProviderModelIds: [seededModels.openai.id],
            strategy: "balanced",
            virtualModelId,
          });
          await page.goto(`${baseUrl}/models?virtualModelDialog=${virtualModelId}`);
          const candidateTable = page.locator(".vm-candidate-table");
          await expect(candidateTable).toContainText("GPT 4.1 Mini");
          await expect(candidateTable).toContainText("128K");
          await expect(candidateTable).toContainText("Yes");

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

          const routePolicyId = await readRoutePolicyId(fixture);
          await postRoutePolicyAction(page, {
            action: "update",
            fallbackProviderModelIds: [seededModels.openai.id],
            id: routePolicyId,
            primaryProviderModelIds: [seededModels.anthropic.id],
            strategy: "quality_first",
            virtualModelId,
          });

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

          await postRoutePolicyAction(page, {
            action: "delete",
            id: routePolicyId,
          });
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
  selectorLabel: string;
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
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = 0.40,
          synced_output_usd_per_million_tokens = 1.60,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'https://models.dev/api.json',
          synced_price_version = 'models.dev:029',
          synced_price_synced_at = now(),
          synced_price_updated_at = now()
      where model_id = 'gpt-4.1-mini'
    `,
  );

  return {
    anthropic: {
      id: anthropicModelId,
      optionLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4)",
      selectorLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4) - Unknown price",
    },
    openai: {
      id: openaiModelId,
      optionLabel: "OpenAI - GPT 4.1 Mini (gpt-4.1-mini)",
      selectorLabel: "OpenAI - GPT 4.1 Mini (gpt-4.1-mini) - Priced (price sync)",
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
    "select count(*)::integer as count from route_policies where deleted_at is null",
  );
  return result.rows[0]?.count ?? 0;
}

async function readRoutePolicyId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>("select id::text from route_policies");
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("Route policy was not found.");
  }
  return id;
}

async function readVirtualModelId(fixture: Fixture, name: string): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text from virtual_models where name = $1",
    [name],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`Virtual model ${name} was not found.`);
  }
  return id;
}

async function postVirtualModelAction(
  page: Page,
  input: { action: string; description: string; name: string },
): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", payload.action);
    body.set("name", payload.name);
    body.set("description", payload.description);
    const response = await fetch("/api/virtual-models", { body, method: "POST" });
    return { status: response.status, text: await response.text() };
  }, input);
  expect(result.status).toBe(200);
}

async function postRoutePolicyAction(
  page: Page,
  input: {
    action: string;
    fallbackProviderModelIds?: string[];
    id?: string;
    primaryProviderModelIds?: string[];
    strategy?: string;
    virtualModelId?: string;
  },
): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", payload.action);
    if (payload.id) {
      body.set("id", payload.id);
    }
    if (payload.virtualModelId) {
      body.set("virtualModelId", payload.virtualModelId);
    }
    if (payload.strategy) {
      body.set("strategy", payload.strategy);
    }
    for (const providerModelId of payload.primaryProviderModelIds ?? []) {
      body.append("primaryProviderModelIds", providerModelId);
    }
    for (const providerModelId of payload.fallbackProviderModelIds ?? []) {
      body.append("fallbackProviderModelIds", providerModelId);
    }
    const response = await fetch("/api/route-policies", { body, method: "POST" });
    return { status: response.status, text: await response.text() };
  }, input);
  expect(result.status).toBe(200);
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
