import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("default virtual model must be in allowed list", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_key_models_${randomUUID().replaceAll("-", "_")}`,
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

          await createVirtualModel(page, {
            displayName: "Coding Fast",
            name: "coding-fast",
          });
          await createVirtualModel(page, {
            displayName: "Coding Strong",
            name: "coding-strong",
          });
          const virtualModels = await readVirtualModels(fixture);

          await page.getByLabel("Agent name").fill("Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Codex" })).toBeVisible();

          await page.getByRole("button", { name: "Create Agent API key" }).click();
          await expect(page.getByRole("heading", { name: "Agent API key created" })).toBeVisible();
          await page.getByRole("link", { name: "Back to dashboard" }).click();

          const apiKeyId = await readOnlyAgentApiKeyId(fixture);

          await expect(page.getByLabel("Allowed virtual models")).toBeVisible({ timeout: 3_000 });
          await page
            .getByLabel("Allowed virtual models")
            .selectOption([
              { label: "Coding Fast (coding-fast)" },
              { label: "Coding Strong (coding-strong)" },
            ]);
          await page
            .getByLabel("Default virtual model")
            .selectOption({ label: "Coding Fast (coding-fast)" });
          await page.getByRole("button", { name: "Save Agent API key virtual models" }).click();

          await expect(
            page.getByText("Allowed Virtual Models: Coding Fast (coding-fast), Coding Strong"),
          ).toBeVisible();
          await expect(
            page.getByText("Default Virtual Model: Coding Fast (coding-fast)"),
          ).toBeVisible();
          await expect
            .poll(() => readAgentApiKeyVirtualModelAccess(fixture))
            .toEqual({
              allowedVirtualModelNames: ["coding-fast", "coding-strong"],
              configChangeTables: ["agent_api_keys", "agent_api_key_virtual_models"],
              defaultVirtualModelName: "coding-fast",
            });

          const invalidResult = await postInvalidDefaultVirtualModel(page, {
            allowedVirtualModelId: virtualModels.fast.id,
            apiKeyId,
            defaultVirtualModelId: virtualModels.strong.id,
          });
          expect(invalidResult).toEqual({
            body: { error: expect.stringMatching(/default virtual model.*allowed/i) },
            status: 400,
          });
          await expect
            .poll(() => readAgentApiKeyVirtualModelAccess(fixture))
            .toEqual({
              allowedVirtualModelNames: ["coding-fast", "coding-strong"],
              configChangeTables: ["agent_api_keys", "agent_api_key_virtual_models"],
              defaultVirtualModelName: "coding-fast",
            });
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

type VirtualModelIds = {
  fast: { id: string; name: string };
  strong: { id: string; name: string };
};

async function createVirtualModel(
  page: Page,
  input: { displayName: string; name: string },
): Promise<void> {
  await page.getByRole("textbox", { exact: true, name: "Virtual model name" }).fill(input.name);
  await page
    .getByRole("textbox", { exact: true, name: "Virtual model display name" })
    .fill(input.displayName);
  await page.getByRole("button", { name: "Create virtual model" }).click();
  await expect(page.getByRole("heading", { name: input.displayName })).toBeVisible();
}

async function readVirtualModels(fixture: Fixture): Promise<VirtualModelIds> {
  const result = await fixture.query<{ id: string; name: string }>(
    "select id::text, name from virtual_models order by name",
  );
  const byName = new Map(result.rows.map((row) => [row.name, row]));
  const fast = byName.get("coding-fast");
  const strong = byName.get("coding-strong");
  if (!fast || !strong) {
    throw new Error("Expected test virtual models were not created.");
  }
  return { fast, strong };
}

async function readOnlyAgentApiKeyId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>("select id::text from agent_api_keys");
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Expected exactly one Agent API key.");
  }
  return row.id;
}

async function readAgentApiKeyVirtualModelAccess(fixture: Fixture) {
  const access = await fixture.query<{
    allowed_virtual_model_names: string[];
    default_virtual_model_name: string | null;
  }>(
    `
      select agent_api_keys.default_virtual_model_id,
             default_virtual_models.name as default_virtual_model_name,
             coalesce(
               array_agg(allowed_virtual_models.name order by allowed_virtual_models.name)
                 filter (where allowed_virtual_models.id is not null),
               '{}'::text[]
             ) as allowed_virtual_model_names
      from agent_api_keys
      left join virtual_models default_virtual_models
        on default_virtual_models.id = agent_api_keys.default_virtual_model_id
      left join agent_api_key_virtual_models
        on agent_api_key_virtual_models.agent_api_key_id = agent_api_keys.id
      left join virtual_models allowed_virtual_models
        on allowed_virtual_models.id = agent_api_key_virtual_models.virtual_model_id
      group by agent_api_keys.id, default_virtual_models.name
    `,
  );
  const configEvents = await fixture.query<{ changed_table: string }>(
    `
      select distinct changed_table
      from config_change_events
      where changed_table in ('agent_api_keys', 'agent_api_key_virtual_models')
      order by changed_table
    `,
  );
  const row = access.rows[0];
  if (!row) {
    throw new Error("Agent API key access state was not found.");
  }

  return {
    allowedVirtualModelNames: row.allowed_virtual_model_names,
    configChangeTables: configEvents.rows.map((event) => event.changed_table),
    defaultVirtualModelName: row.default_virtual_model_name,
  };
}

async function postInvalidDefaultVirtualModel(
  page: Page,
  input: {
    allowedVirtualModelId: string;
    apiKeyId: string;
    defaultVirtualModelId: string;
  },
) {
  return page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", "updateVirtualModelAccess");
    body.set("id", payload.apiKeyId);
    body.append("allowedVirtualModelIds", payload.allowedVirtualModelId);
    body.set("defaultVirtualModelId", payload.defaultVirtualModelId);

    const response = await fetch("/api/agent-api-keys", { body, method: "POST" });
    return {
      body: await response.json(),
      status: response.status,
    };
  }, input);
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
