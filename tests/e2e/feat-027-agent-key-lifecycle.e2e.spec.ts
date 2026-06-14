import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("agent key plaintext once hash prefix status metadata persisted after rotate disable delete", async ({
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
            key_hash_contains_rotated: false,
            key_prefix: firstKey.slice(0, 12),
          });

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(firstKey)).toHaveCount(0);
          await expect(
            page.getByText(`Agent API key prefix: ${firstKey.slice(0, 12)}`),
          ).toBeVisible();
          await expect(page.getByText("Agent API key status: Enabled")).toBeVisible();

          await page.reload();
          await expect(page.getByText(firstKey)).toHaveCount(0);
          await expect(
            page.getByText(`Agent API key prefix: ${firstKey.slice(0, 12)}`),
          ).toBeVisible();

          await page.getByRole("button", { name: "Rotate Agent API key" }).click();
          await expect(page.getByRole("heading", { name: "Agent API key rotated" })).toBeVisible();
          const rotatedKey = await page.locator("code").innerText();
          expect(rotatedKey).toMatch(/^llmi_[A-Za-z0-9_-]{32,}$/);
          expect(rotatedKey).not.toBe(firstKey);

          const rotatedRows = await readAgentKeyRows(fixture, { firstKey, rotatedKey });
          expect(rotatedRows).toHaveLength(1);
          expect(rotatedRows[0]).toMatchObject({
            enabled: true,
            key_hash_contains_first: false,
            key_hash_contains_rotated: false,
            key_prefix: rotatedKey.slice(0, 12),
          });

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(firstKey)).toHaveCount(0);
          await expect(page.getByText(rotatedKey)).toHaveCount(0);
          await expect(
            page.getByText(`Agent API key prefix: ${rotatedKey.slice(0, 12)}`),
          ).toBeVisible();

          await page.getByRole("button", { name: "Disable Agent API key" }).click();
          await expect(page.getByText("Agent API key status: Disabled")).toBeVisible();
          expect(await readAgentKeyStatuses(fixture)).toEqual([false]);

          await page.getByRole("button", { name: "Delete Agent API key" }).click();
          await expect(page.getByText("No Agent API keys saved.")).toBeVisible();
          expect(await readAgentKeyStatuses(fixture)).toEqual([]);
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
  key_hash_contains_rotated: boolean;
  key_prefix: string;
};

async function readAgentKeyRows(
  fixture: Fixture,
  keys: { firstKey?: string; rotatedKey?: string } = {},
): Promise<AgentKeyStorageRow[]> {
  const result = await fixture.query<AgentKeyStorageRow>(
    `
      select agents.name as agent_name,
             agent_api_keys.key_prefix,
             agent_api_keys.enabled,
             agent_api_keys.created_at is not null as has_created_at,
             agent_api_keys.updated_at is not null as has_updated_at,
             agent_api_keys.key_hash like $1 as key_hash_contains_first,
             agent_api_keys.key_hash like $2 as key_hash_contains_rotated
      from agent_api_keys
      join agents on agents.id = agent_api_keys.agent_id
      order by agent_api_keys.created_at
    `,
    [`%${keys.firstKey ?? "missing-first-key"}%`, `%${keys.rotatedKey ?? "missing-rotated-key"}%`],
  );
  return result.rows;
}

async function readAgentKeyStatuses(fixture: Fixture): Promise<boolean[]> {
  const result = await fixture.query<{ enabled: boolean }>(
    "select enabled from agent_api_keys order by created_at",
  );
  return result.rows.map((row) => row.enabled);
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
