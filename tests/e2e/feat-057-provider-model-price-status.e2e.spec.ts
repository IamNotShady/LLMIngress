import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openRow } from "../support/console-ui";
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
      { contextWindow: 128_000, id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { contextWindow: 8192, id: "manual-priced-model", name: "Manual Priced Model" },
      { contextWindow: 8192, id: "unknown-refresh-model", name: "Unknown Refresh Model" },
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

    await withProcessLock("llmingress-console-next-dev", async () => {
      const worker = startWorkerProcess({ databaseUrl: fixture.databaseUrl });
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const consoleBaseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForWorkerStarted(worker);
          await waitForConsole(consoleBaseUrl, consoleApp);
          await signInFromFirstRun(page, consoleBaseUrl);
          await page.goto(`${consoleBaseUrl}/providers`);

          await storeProviderApiKey(page, providerApiKey);
          await page.goto(`${consoleBaseUrl}/providers`);
          await openRow(page, "OpenAI Price Status Provider");
          await page.getByRole("button", { name: "Refresh models" }).click();

          await expect
            .poll(() => readLatestModelRefreshJob(fixture, providerId))
            .toMatchObject({ status: "succeeded" });
          await writeDeterministicPriceStatusRows(fixture, providerId);
          const providerModels = await readProviderModels(fixture, providerId);
          expect(providerModels.map((model) => model.model_id).sort()).toEqual([
            "gpt-4.1-mini",
            "manual-priced-model",
            "unknown-refresh-model",
          ]);

          await page.goto(`${consoleBaseUrl}/providers`);
          await openRow(page, "OpenAI Price Status Provider");
          const library = page.locator("table.model-library-table");
          await expect(library.getByText("GPT-4.1 Mini")).toBeVisible();
          await expect(library.getByText("$0.4000")).toBeVisible();
          await expect(library.getByText("$1.60")).toBeVisible();
          await expect(library.getByText("Manual Priced Model")).toBeVisible();
          await expect(library.getByText("$2.50")).toBeVisible();
          await expect(library.getByText("$7.50")).toBeVisible();
          await expect(library.getByText("Unknown Refresh Model")).toBeVisible();
          await expect(
            library
              .getByRole("row", { name: /Unknown Refresh Model/ })
              .getByText("未知")
              .first(),
          ).toBeVisible();

          await postVirtualModelWithRoute(page, {
            description: "Price Status VM",
            name: "price-status-vm",
            primaryProviderModelIds: providerModels.map((model) => model.id),
            strategy: "balanced",
          });
          await expect.poll(() => countRoutePolicyCandidates(fixture)).toBe(3);
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

async function writeDeterministicPriceStatusRows(
  fixture: Fixture,
  providerId: string,
): Promise<void> {
  await fixture.query(
    `
      update provider_models
      set manual_input_usd_per_million_tokens = 2.50,
          manual_output_usd_per_million_tokens = 7.50,
          manual_price_updated_at = now()
      where provider_id = $1
        and model_id = 'manual-priced-model'
    `,
    [providerId],
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = 0.40,
          synced_output_usd_per_million_tokens = 1.60,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'https://models.dev/api.json',
          synced_price_version = 'models.dev:test',
          synced_price_synced_at = now(),
          synced_price_updated_at = now()
      where provider_id = $1
        and model_id = 'gpt-4.1-mini'
    `,
    [providerId],
  );
}

async function storeProviderApiKey(page: Page, providerApiKey: string): Promise<void> {
  await openRow(page, "OpenAI Price Status Provider");
  await page.getByRole("link", { name: "Add API key" }).click();
  await page
    .getByRole("dialog", { name: /API key/ })
    .getByRole("textbox", { name: "Provider API key" })
    .fill(providerApiKey);
  await page.getByRole("button", { name: "Save API key" }).click();
  await expect(page.getByRole("heading", { name: "Provider API key saved" })).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await openRow(page, "OpenAI Price Status Provider");
  await expect(page.locator("table.provider-key-table td.mono")).toHaveText("sk-price");
}

async function readProviderModels(
  fixture: Fixture,
  providerId: string,
): Promise<Array<{ id: string; model_id: string }>> {
  const result = await fixture.query<{ id: string; model_id: string }>(
    `
      select id::text, model_id
      from provider_models
      where provider_id = $1
    `,
    [providerId],
  );
  return result.rows;
}

async function countRoutePolicyCandidates(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from route_policy_candidates",
  );
  return result.rows[0]?.count ?? 0;
}

async function postVirtualModelWithRoute(
  page: Page,
  input: {
    description: string;
    name: string;
    primaryProviderModelIds: string[];
    strategy: string;
  },
): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", "createWithRoute");
    body.set("name", payload.name);
    body.set("description", payload.description);
    body.set("strategy", payload.strategy);
    for (const providerModelId of payload.primaryProviderModelIds) {
      body.append("primaryProviderModelIds", providerModelId);
    }
    const response = await fetch("/api/virtual-models", { body, method: "POST" });
    return { status: response.status, text: await response.text() };
  }, input);
  expect(result.status, result.text).toBe(200);
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
