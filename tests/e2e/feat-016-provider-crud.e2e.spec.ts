import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("provider crud enable disable and disabled provider leaves routing snapshot", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_crud_${randomUUID().replaceAll("-", "_")}`,
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
          await page.goto(`${baseUrl}/providers`);

          await page.getByRole("link", { name: "+ 添加 Provider" }).click();
          await expect(page.getByRole("dialog", { name: "添加 Provider" })).toBeVisible();
          await page.getByLabel("Provider type").selectOption("openai");
          await page.getByLabel("Provider display name").fill("OpenAI");
          await page.getByLabel("Provider base URL").fill("https://api.openai.com/v1");
          await page.getByRole("button", { name: "Create provider" }).click();

          await expect(page.getByRole("heading", { name: "Provider 详情 - OpenAI" })).toBeVisible();
          await expect.poll(() => routingProviderKeys(fixture.databaseUrl)).toEqual(["openai"]);

          await page.getByRole("link", { name: "Edit OpenAI" }).click();
          await expect(page.getByRole("dialog", { name: "编辑 OpenAI" })).toBeVisible();
          await page.getByLabel("Provider display name").fill("OpenAI API");
          await page.getByRole("button", { name: "Save provider" }).click();

          await expect(
            page.getByRole("heading", { name: "Provider 详情 - OpenAI API" }),
          ).toBeVisible();

          await page.getByRole("button", { name: "Disable OpenAI API" }).click();
          await expect(page.getByRole("button", { name: "Enable OpenAI API" })).toBeVisible();
          await expect.poll(() => routingProviderKeys(fixture.databaseUrl)).toEqual([]);

          await page.getByRole("button", { name: "Enable OpenAI API" }).click();
          await expect(page.getByRole("button", { name: "Disable OpenAI API" })).toBeVisible();
          await expect.poll(() => routingProviderKeys(fixture.databaseUrl)).toEqual(["openai"]);
          await expect.poll(async () => countProviderConfigChanges(fixture)).toBe(4);
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

type ProviderConfigChangeCount = {
  count: number;
};

async function countProviderConfigChanges(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<number> {
  const result = await fixture.query<ProviderConfigChangeCount>(
    `
      select count(*)::integer as count
      from config_versions
      cross join lateral jsonb_array_elements(config_versions.changes) as change(value)
      where change.value->>'source' = 'console'
        and change.value->>'table' = 'providers'
    `,
  );
  return result.rows[0]?.count ?? 0;
}

async function routingProviderKeys(databaseUrl: string): Promise<string[]> {
  const snapshot = await loadGatewayConfigSnapshot(databaseUrl);
  return snapshot.providers.map((provider) => provider.providerKey);
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
