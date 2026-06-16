import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, loadSqlMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("migration status reports schema pending migrations and migrate check health", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_migration_status_${randomUUID().replaceAll("-", "_")}`,
  });
  const migrations = loadSqlMigrations();
  const latestMigration = migrations.at(-1);
  const currentMigration = migrations.at(-2);

  if (!latestMigration || !currentMigration) {
    throw new Error("feat-087 requires at least two migrations.");
  }

  try {
    await applyMigrationsThrough(fixture, currentMigration.id);

    const cliResult = spawnSync(
      "pnpm",
      ["run", "db:migrate:status", "--", "--database-url", fixture.databaseUrl],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      },
    );
    expect(cliResult.status, cliResult.stderr || cliResult.stdout).toBe(0);
    expect(cliResult.stdout).toContain(`Current schema: ${currentMigration.id}`);
    expect(cliResult.stdout).toContain(
      `Pending migrations: ${latestMigration.id}_${latestMigration.name}`,
    );
    expect(cliResult.stdout).toContain("db:migrate:check health: Ready");

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

          const runtimeSection = page.getByLabel("Runtime");
          await expect(
            runtimeSection.getByText(`Current schema: ${currentMigration.id}`),
          ).toBeVisible();
          await expect(
            runtimeSection.getByText(
              `Pending migrations: ${latestMigration.id}_${latestMigration.name}`,
            ),
          ).toBeVisible();
          await expect(runtimeSection.getByText(/db:migrate:check health: Ready/)).toBeVisible();
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

async function applyMigrationsThrough(fixture: Fixture, targetId: string): Promise<void> {
  const migrations = loadSqlMigrations();
  for (const migration of migrations) {
    if (migration.id > targetId) {
      break;
    }

    await fixture.query(migration.sql);
    await fixture.query(
      `
        insert into migration_history (id, name, checksum)
        values ($1, $2, $3)
      `,
      [migration.id, migration.name, migration.checksum],
    );
  }
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
        message: () =>
          `Console did not start. stdout=${consoleApp.stdout.join("")} stderr=${consoleApp.stderr.join("")}`,
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
