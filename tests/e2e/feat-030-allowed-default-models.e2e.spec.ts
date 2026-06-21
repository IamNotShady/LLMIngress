import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
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
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await page.goto(`${baseUrl}/models`);

          await createVirtualModel(page, {
            displayName: "Coding Fast",
            name: "coding-fast",
          });
          await createVirtualModel(page, {
            displayName: "Coding Strong",
            name: "coding-strong",
          });
          const virtualModels = await readVirtualModels(fixture);

          await page.goto(`${baseUrl}/agents`);
          await openDisclosure(page, "New agent");
          await page.getByLabel("Agent name").fill("Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
          await page.getByRole("link", { name: "Back to dashboard" }).click();

          const apiKeyId = await readOnlyAgentApiKeyId(fixture);

          await openRow(page, "Codex");
          await expect(page.getByLabel("Allowed virtual models")).toBeVisible({ timeout: 3_000 });
          await page
            .getByLabel("Allowed virtual models")
            .selectOption([{ label: "Coding Fast (coding-fast)" }]);
          await page
            .getByLabel("Default virtual model")
            .selectOption({ label: "Coding Fast (coding-fast)" });
          await page.getByRole("button", { exact: true, name: "Save" }).click();

          await openRow(page, "Codex");
          await expect(page.getByLabel("Allowed virtual models")).toHaveValues([
            virtualModels.fast.id,
          ]);
          await expect(page.getByLabel("Default virtual model")).toHaveValue(virtualModels.fast.id);
          await expect
            .poll(() => readAgentApiKeyVirtualModelAccess(fixture))
            .toEqual({
              allowedVirtualModelNames: ["coding-fast"],
              configChangeTables: ["agents", "agent_virtual_models"],
              defaultVirtualModelName: "coding-fast",
            });

          const defaultCoercionResult = await postDefaultVirtualModelForm(page, {
            allowedVirtualModelId: virtualModels.fast.id,
            apiKeyId,
            defaultVirtualModelId: virtualModels.strong.id,
          });
          expect(defaultCoercionResult).toEqual({
            redirected: true,
            status: 200,
          });
          await expect
            .poll(() => readAgentApiKeyVirtualModelAccess(fixture))
            .toEqual({
              allowedVirtualModelNames: ["coding-fast", "coding-strong"],
              configChangeTables: ["agents", "agent_virtual_models"],
              defaultVirtualModelName: "coding-strong",
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
  await openDisclosure(page, "New virtual model");
  await page.getByRole("textbox", { exact: true, name: "Virtual Model 名称" }).fill(input.name);
  await page.getByRole("textbox", { exact: true, name: "描述" }).fill(input.displayName);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("link", { name: input.name })).toBeVisible();
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
  const result = await fixture.query<{ id: string }>(
    "select id::text from agents where key_hash is not null",
  );
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
      select agents.default_virtual_model_id,
             default_virtual_models.name as default_virtual_model_name,
             coalesce(
               array_agg(allowed_virtual_models.name order by allowed_virtual_models.name)
                 filter (where allowed_virtual_models.id is not null),
               '{}'::text[]
             ) as allowed_virtual_model_names
      from agents
      left join virtual_models default_virtual_models
        on default_virtual_models.id = agents.default_virtual_model_id
      left join agent_virtual_models
        on agent_virtual_models.agent_id = agents.id
      left join virtual_models allowed_virtual_models
        on allowed_virtual_models.id = agent_virtual_models.virtual_model_id
      group by agents.id, default_virtual_models.name
    `,
  );
  const configEvents = await fixture.query<{ changed_table: string }>(
    `
      select distinct change.value->>'table' as changed_table
      from config_versions
      cross join lateral jsonb_array_elements(config_versions.changes) as change(value)
      where change.value->>'table' in ('agents', 'agent_virtual_models')
      order by change.value->>'table'
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

async function postDefaultVirtualModelForm(
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

    const response = await fetch("/api/agents", { body, method: "POST" });
    return {
      redirected: response.redirected,
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
