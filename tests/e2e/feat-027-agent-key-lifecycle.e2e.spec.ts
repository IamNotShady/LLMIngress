import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("agent creation returns one plaintext key and removes independent key lifecycle", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_key_${randomUUID().replaceAll("-", "_")}`,
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
          await page.goto(`${baseUrl}/agents`);

          await openDisclosure(page, "New agent");
          await page.getByLabel("Agent name").fill("Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
          const firstKey = await page.locator("code").innerText();
          expect(firstKey).toMatch(/^llmi_[A-Za-z0-9_-]{32,}$/);

          const createdRows = await readAgentKeyRows(fixture);
          expect(createdRows).toHaveLength(1);
          expect(createdRows[0]).toMatchObject({
            agent_name: "Codex",
            enabled: true,
            has_created_at: true,
            has_updated_at: true,
            key_hash_contains_first: false,
            key_prefix: firstKey.slice(0, 12),
            legacy_key_tables: "absent",
          });

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(firstKey)).toHaveCount(0);
          await openRow(page, "Codex");
          await expect(page.getByText(/^Agent API key prefix:/)).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Create Agent API key" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Rotate Agent API key" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Disable Agent API key" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Delete Agent API key" })).toHaveCount(0);

          await page.reload();
          await expect(page.getByText(firstKey)).toHaveCount(0);
          await openRow(page, "Codex");
          await expect(page.getByText(/^Agent API key prefix:/)).toHaveCount(0);
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

type AgentKeyStorageRow = {
  agent_name: string;
  enabled: boolean;
  has_created_at: boolean;
  has_updated_at: boolean;
  key_hash_contains_first: boolean;
  key_prefix: string;
  legacy_key_tables: "absent" | "present";
};

async function readAgentKeyRows(
  fixture: Fixture,
  keys: { firstKey?: string } = {},
): Promise<AgentKeyStorageRow[]> {
  const result = await fixture.query<AgentKeyStorageRow>(
    `
      select agents.name as agent_name,
             agents.key_prefix,
             agents.enabled,
             agents.created_at is not null as has_created_at,
             agents.updated_at is not null as has_updated_at,
             agents.key_hash like $1 as key_hash_contains_first,
             case
               when to_regclass('agent_api_keys') is null
                and to_regclass('agent_api_key_virtual_models') is null
               then 'absent'
               else 'present'
             end as legacy_key_tables
      from agents
      where agents.key_hash is not null
      order by agents.created_at
    `,
    [`%${keys.firstKey ?? "missing-first-key"}%`],
  );
  return result.rows;
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
