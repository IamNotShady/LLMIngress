import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

const masterKey = "test-master-key";

test("refresh provider models shows priced and unknown price status in provider and route selectors", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_model_price_status_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerApiKey = "sk-price-status-secret";
  const provider = await createFakeProviderServer({
    models: [
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "manual-priced-model", name: "Manual Priced Model" },
      { id: "unknown-refresh-model", name: "Unknown Refresh Model" },
    ],
    requiredModelListAuthorization: `Bearer ${providerApiKey}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${provider.url}/v1`,
      id: providerId,
    });
    await insertManualPriceOverride(fixture);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const worker = startWorkerProcess({ databaseUrl: fixture.databaseUrl });
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const consoleBaseUrl = `http://127.0.0.1:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForWorkerStarted(worker);
          await waitForConsole(consoleBaseUrl, consoleApp);
          await signInFromFirstRun(page, consoleBaseUrl);

          await storeProviderApiKey(page, providerApiKey);
          await createVirtualModel(page);
          await page.getByRole("button", { name: "Refresh provider models" }).click();
          await expect(
            page.getByText("Model refresh queued for OpenAI Price Status Provider."),
          ).toBeVisible();

          await expect
            .poll(() => readLatestModelRefreshJob(fixture, providerId))
            .toMatchObject({ status: "succeeded" });

          await page.reload();
          const providerModelMetadata = page.locator(".provider-model-metadata");
          await expect(
            providerModelMetadata.getByText("GPT-4.1 Mini (gpt-4.1-mini) - Priced (built-in)"),
          ).toBeVisible();
          await expect(
            providerModelMetadata.getByText(
              "Manual Priced Model (manual-priced-model) - Priced (manual override)",
            ),
          ).toBeVisible();
          await expect(
            providerModelMetadata.getByText(
              "Unknown Refresh Model (unknown-refresh-model) - Unknown price",
            ),
          ).toBeVisible();

          await page.getByLabel("Route policy virtual model").selectOption({
            label: "Price Status VM (price-status-vm)",
          });
          await expect(page.getByLabel("Primary provider models")).toContainText(
            "OpenAI Price Status Provider - GPT-4.1 Mini (gpt-4.1-mini) - Priced (built-in)",
          );
          await expect(page.getByLabel("Primary provider models")).toContainText(
            "OpenAI Price Status Provider - Manual Priced Model (manual-priced-model) - Priced (manual override)",
          );
          await expect(page.getByLabel("Primary provider models")).toContainText(
            "OpenAI Price Status Provider - Unknown Refresh Model (unknown-refresh-model) - Unknown price",
          );
        } finally {
          await context.close();
        }
      } finally {
        await stopProcess(consoleApp.child);
        await stopProcess(worker.child);
      }
    });
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type AppProcess = {
  child: ChildProcessWithoutNullStreams;
  stderr: string[];
  stdout: string[];
};

type ConsoleProcess = AppProcess & {
  port: number;
};

async function insertProvider(
  fixture: Fixture,
  input: { baseUrl: string; id: string },
): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Price Status Provider', $2, true)
    `,
    [input.id, input.baseUrl],
  );
}

async function insertManualPriceOverride(fixture: Fixture): Promise<void> {
  await fixture.query(
    `
      insert into model_price_overrides (
        id,
        provider_key,
        model_id,
        input_usd_per_million_tokens,
        output_usd_per_million_tokens
      )
      values ($1, 'openai', 'manual-priced-model', 2.50, 7.50)
    `,
    [randomUUID()],
  );
}

async function storeProviderApiKey(page: Page, providerApiKey: string): Promise<void> {
  await page.getByLabel("Provider API key").fill(providerApiKey);
  await page.getByRole("button", { name: "Store provider API key" }).click();
  await expect(page.getByRole("heading", { name: "Provider API key saved" })).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(page.getByText("Provider API key prefix: sk-price")).toBeVisible();
}

async function createVirtualModel(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Virtual model name" }).fill("price-status-vm");
  await page.getByRole("textbox", { name: "Virtual model display name" }).fill("Price Status VM");
  await page.getByRole("button", { name: "Create virtual model" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "Price Status VM" })).toBeVisible();
}

async function readLatestModelRefreshJob(
  fixture: Fixture,
  providerId: string,
): Promise<{ status: string } | null> {
  const result = await fixture.query<{ status: string }>(
    `
      select status
      from jobs
      where job_type = 'model_refresh'
        and payload->>'providerId' = $1
      order by created_at desc
      limit 1
    `,
    [providerId],
  );
  return result.rows[0] ?? null;
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
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
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
  let lastObservedStatus = "not-started";

  await expect
    .poll(
      async () => {
        if (consoleApp.child.exitCode !== null) {
          return formatConsoleStartupFailure(consoleApp, lastObservedStatus);
        }

        try {
          const response = await fetch(baseUrl);
          if (response.status !== 200) {
            lastObservedStatus = `status:${response.status}:${(await response.text()).slice(0, 500)}`;
            return lastObservedStatus;
          }
          lastObservedStatus = String(response.status);
          return response.status;
        } catch (error) {
          lastObservedStatus = `fetch-error:${
            error instanceof Error ? error.message : String(error)
          }`;
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

function formatConsoleStartupFailure(
  consoleApp: ConsoleProcess,
  lastObservedStatus: string,
): string {
  return [
    `exited:${consoleApp.child.exitCode}`,
    `last:${lastObservedStatus}`,
    `stdout:${consoleApp.stdout.join("")}`,
    `stderr:${consoleApp.stderr.join("")}`,
  ].join("\n");
}

async function waitForWorkerStarted(worker: AppProcess): Promise<void> {
  await expect
    .poll(
      () => {
        if (worker.child.exitCode !== null) {
          return `exited:${worker.child.exitCode}`;
        }
        return worker.stdout.join("").includes("[worker] started") ? "started" : "not-ready";
      },
      {
        message: `Worker did not start.\nstdout=${worker.stdout.join("")}\nstderr=${worker.stderr.join("")}`,
        timeout: 15_000,
      },
    )
    .toBe("started");
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
        MASTER_KEY: masterKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return captureProcess(child, { port: options.port });
}

function startWorkerProcess(options: { databaseUrl: string }): AppProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/worker", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      MASTER_KEY: masterKey,
      WORKER_HEARTBEAT_MS: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return captureProcess(child);
}

function captureProcess<T extends object>(
  child: ChildProcessWithoutNullStreams,
  extra?: T,
): AppProcess & T {
  const app = {
    ...(extra ?? ({} as T)),
    child,
    stderr: [],
    stdout: [],
  } as AppProcess & T;
  child.stderr.on("data", (chunk) => app.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => app.stdout.push(String(chunk)));
  return app;
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
