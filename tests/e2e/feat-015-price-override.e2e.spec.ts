import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("console shows unknown current price and manual price override changes subsequent cost estimate", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_price_override_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedPricedProviderModel(fixture);

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
          await page.goto(`${baseUrl}/pricing`);

          await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
          // Scope to the price-override panel ("Unknown price" / "Manual override" also
          // appear as the price-source column in the model directory table above it).
          const pricePanel = page.locator(".price-panel");
          await expect(pricePanel.getByText("Unknown price")).toBeVisible();
          await expect(pricePanel.getByText("Unknown input price")).toBeVisible();
          await expect(pricePanel.getByText("Unknown output price")).toBeVisible();
          await expect(pricePanel.getByText("Sample estimate: unavailable")).toBeVisible();

          await page.getByLabel("Override input price").fill("9");
          await page.getByLabel("Override output price").fill("10");
          await page.getByRole("button", { name: "Save price override" }).click();

          await expect(pricePanel.getByText("Manual override")).toBeVisible();
          await expect(pricePanel.getByText("$9.00 / 1M input")).toBeVisible();
          await expect(pricePanel.getByText("$10.00 / 1M output")).toBeVisible();
          await expect(pricePanel.getByText("Sample estimate: $19.00")).toBeVisible();
          await expect.poll(async () => countPriceOverrideConfigChanges(fixture)).toBe(1);
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

type PriceOverrideConfigChangeCount = {
  count: number;
};

async function countPriceOverrideConfigChanges(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<number> {
  const result = await fixture.query<PriceOverrideConfigChangeCount>(
    `
      select count(*)::integer as count
      from config_change_events
      where source = 'console'
        and changed_table = 'provider_models'
    `,
  );
  return result.rows[0]?.count ?? 0;
}

async function seedPricedProviderModel(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<void> {
  const providerId = randomUUID();
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Pricing Provider', 'https://api.openai.com/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'GPT-4.1 Mini', 'available')
    `,
    [randomUUID(), providerId],
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
          throw new Error(
            [
              `Console exited with code ${consoleApp.child.exitCode}.`,
              ...consoleApp.stderr,
              ...consoleApp.stdout,
            ].join("\n"),
          );
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
