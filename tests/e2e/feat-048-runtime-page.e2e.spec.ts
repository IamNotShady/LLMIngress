import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("runtime page shows heartbeat config version reload result and recent errors", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_runtime_page_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedRuntimePageData(fixture);

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

          await page.goto(`${baseUrl}/runtime`);

          const runtimeSection = page.getByLabel("Gateway Runtime");
          await expect(
            page.getByRole("heading", { level: 1, name: "Gateway Runtime" }),
          ).toBeVisible();
          // Status cards: gateway status + heartbeat.
          await expect(
            runtimeSection
              .locator(".stat-card", { hasText: "Gateway status" })
              .locator(".stat-card-value"),
          ).toHaveText("degraded");
          await expect(
            runtimeSection
              .locator(".stat-card", { hasText: "Heartbeat" })
              .locator(".stat-card-value"),
          ).toHaveText("Healthy");
          // Config versions + reload result.
          await expect(runtimeSection.getByText("v7", { exact: true })).toBeVisible();
          await expect(runtimeSection.getByText("v8", { exact: true })).toBeVisible();
          await expect(
            runtimeSection.getByText(/Reload failed at .*provider key missing/),
          ).toBeVisible();
          // Recent runtime errors table rows (source + code + message).
          await expect(
            runtimeSection.getByRole("row", {
              name: /gateway.*config_reload_failed.*Provider key missing/,
            }),
          ).toBeVisible();
          await expect(
            runtimeSection.getByRole("row", {
              name: /worker.*reservation_cleanup_delayed.*Cleanup lag high/,
            }),
          ).toBeVisible();
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

async function seedRuntimePageData(fixture: Fixture): Promise<void> {
  await fixture.query(
    `
      insert into config_versions (version, source, description)
      values (7, 'console', 'Applied runtime config'),
             (8, 'console', 'Target runtime config')
    `,
  );
  await fixture.query(
    `
      insert into gateway_runtime_status (
        id,
        gateway_instance_id,
        status,
        applied_config_version,
        target_config_version,
        last_reload_status,
        last_reload_error,
        last_reload_at,
        heartbeat_at,
        started_at,
        updated_at
      )
      values (
        $1,
        'gateway-runtime-048',
        'degraded',
        7,
        8,
        'failed',
        'provider key missing',
        now() - interval '30 seconds',
        now() - interval '10 seconds',
        now() - interval '5 minutes',
        now() - interval '10 seconds'
      )
    `,
    [randomUUID()],
  );
  await fixture.query(
    `
      insert into runtime_errors (
        id,
        process_type,
        process_id,
        severity,
        error_code,
        error_message,
        created_at
      )
      values
        ($1, 'gateway', 'gateway-runtime-048', 'fatal', 'config_reload_failed', 'Provider key missing', now() - interval '20 seconds'),
        ($2, 'worker', 'budget-cleaner', 'warning', 'reservation_cleanup_delayed', 'Cleanup lag high', now() - interval '1 minute')
    `,
    [randomUUID(), randomUUID()],
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
