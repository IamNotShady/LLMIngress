import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("console shows provider model health latest probe failures and stale status", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_health_console_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedProviderHealthConsoleData(fixture);

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
          await page.goto(`${baseUrl}/providers`);

          const providerCard = page.locator("article.provider-summary-card", {
            hasText: "Health Console Provider",
          });
          await expect(
            providerCard.getByRole("heading", { name: "Health Console Provider" }),
          ).toBeVisible();
          await expect(providerCard.getByText("可用")).toBeVisible();

          await openRow(page, "Health Console Provider");
          const selectedProviderDetails = page.getByLabel("Selected provider details");
          await expect(
            selectedProviderDetails.getByRole("heading", {
              name: "Provider 详情 - Health Console Provider",
            }),
          ).toBeVisible();
          await expect(selectedProviderDetails).toContainText("可用");
          await expect(
            selectedProviderDetails.locator(".provider-detail-stats div", { hasText: "最近连接" }),
          ).not.toContainText("-");

          const modelLibrary = page.locator(".model-library-card");
          await expect(
            modelLibrary.getByRole("heading", { name: "模型库 - Health Console Provider" }),
          ).toBeVisible();
          await expect(modelLibrary.locator("table.model-library-table")).toContainText(
            "Health Console Model",
          );
          await expect(modelLibrary.locator("table.model-library-table")).toContainText("启用");

          const noProbeCard = page.locator("article.provider-summary-card", {
            hasText: "No Probe Provider",
          });
          await expect(noProbeCard.getByText("未知")).toBeVisible();
          await openRow(page, "No Probe Provider");
          await expect(
            selectedProviderDetails.getByRole("heading", {
              name: "Provider 详情 - No Probe Provider",
            }),
          ).toBeVisible();
          await expect(selectedProviderDetails).toContainText("未知");
          await expect(
            selectedProviderDetails.locator(".provider-detail-stats div", { hasText: "最近连接" }),
          ).toContainText("-");
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

async function seedProviderHealthConsoleData(fixture: Fixture): Promise<void> {
  const providerId = randomUUID();
  const noProbeProviderId = randomUUID();
  const providerModelId = randomUUID();
  const providerEventId = randomUUID();
  const modelEventId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'health-console', 'Health Console Provider', 'https://example.com/v1', true),
             ($2, 'api_key', 'no-probe', 'No Probe Provider', 'https://no-probe.example.com/v1', true)
    `,
    [providerId, noProbeProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        availability
      )
      values ($1, $2, 'health-console-model', 'Health Console Model', 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        trigger,
        status,
        observed_at
      )
      values ($1, $2, null, 'manual', 'healthy', now() - interval '2 minutes'),
             ($3, $2, $4, 'request_path', 'network_error', now() - interval '30 minutes')
    `,
    [providerEventId, providerId, modelEventId, providerModelId],
  );
  await fixture.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        last_event_id,
        status,
        consecutive_failures,
        last_success_at,
        last_failure_at,
        updated_at
      )
      values ($1, $2, null, $3, 'healthy', 0, now() - interval '2 minutes', null, now() - interval '2 minutes'),
             ($4, $2, $5, $6, 'unhealthy', 3, null, now() - interval '30 minutes', now() - interval '30 minutes')
    `,
    [randomUUID(), providerId, providerEventId, randomUUID(), providerModelId, modelEventId],
  );
}

async function signInFromFirstRun(page: Page, baseUrl: string): Promise<void> {
  const password = "correct horse battery staple";

  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "First run setup" })).toBeVisible();
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
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
        message: `Console did not start.\nstdout=${consoleApp.stdout.join("")}\nstderr=${consoleApp.stderr.join("")}`,
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
