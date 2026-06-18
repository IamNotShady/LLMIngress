import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createConfigPublisher } from "../../packages/config/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("running gateway records heartbeat and config version visible on console overview", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_runtime_hb_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const publisher = createConfigPublisher({ databaseUrl: fixture.databaseUrl });
    await publishProvider(publisher, "openai", "OpenAI");

    const gatewayInstanceId = `gateway-099-${randomUUID().slice(0, 8)}`;
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      gatewayInstanceId,
      heartbeatIntervalMs: 500,
      port: await getFreePort(),
      reconcileIntervalMs: 500,
    });

    try {
      const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`;
      await expect
        .poll(async () => (await readHealth(gatewayBaseUrl))?.configVersion ?? -1, {
          timeout: 20_000,
        })
        .toBe(1);

      await withProcessLock("llmingress-console-next-dev", async () => {
        const consoleApp = startConsoleProcess({
          databaseUrl: fixture.databaseUrl,
          port: await getFreePort(),
        });

        try {
          const consoleBaseUrl = `http://localhost:${consoleApp.port}`;
          const context = await browser.newContext();
          const page = await context.newPage();

          try {
            await waitForConsole(consoleBaseUrl, consoleApp);
            await signInFromFirstRun(page, consoleBaseUrl);

            const runtimeSection = page.getByLabel("Runtime");

            // Boot: the running gateway recorded started_at + an initial healthy heartbeat
            // plus the applied config version, so the live instance now shows on the overview.
            await expectAfterReload(page, consoleBaseUrl, async () => {
              await expect(runtimeSection.getByText(`Gateway: ${gatewayInstanceId}`)).toBeVisible();
              await expect(runtimeSection.getByText("Heartbeat: Healthy")).toBeVisible();
              await expect(runtimeSection.getByText("Gateway status: ready")).toBeVisible();
              await expect(runtimeSection.getByText("Applied config version: v1")).toBeVisible();
              await expect(runtimeSection.getByText(/Reload succeeded/)).toBeVisible();
            });

            // Reload: publishing a new config version is applied without restart and the
            // gateway records the new applied/target config version on the same row.
            await publishProvider(publisher, "anthropic", "Anthropic");
            await expect
              .poll(async () => (await readHealth(gatewayBaseUrl))?.configVersion ?? -1, {
                timeout: 20_000,
              })
              .toBe(2);

            await expectAfterReload(page, consoleBaseUrl, async () => {
              await expect(runtimeSection.getByText(`Gateway: ${gatewayInstanceId}`)).toBeVisible();
              await expect(runtimeSection.getByText("Heartbeat: Healthy")).toBeVisible();
              await expect(runtimeSection.getByText("Applied config version: v2")).toBeVisible();
              await expect(runtimeSection.getByText("Target config version: v2")).toBeVisible();
              await expect(runtimeSection.getByText(/Reload succeeded/)).toBeVisible();
            });
          } finally {
            await context.close();
          }
        } finally {
          await stopConsoleProcess(consoleApp);
        }
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fixture.dispose();
  }
});

type ConfigPublisher = ReturnType<typeof createConfigPublisher>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type ConsoleProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

async function publishProvider(
  publisher: ConfigPublisher,
  providerKey: string,
  displayName: string,
) {
  const providerId = randomUUID();
  await publisher.publish({
    source: "console",
    description: `Create ${displayName}`,
    changes: [{ table: "providers", recordId: providerId }],
    write: async (client) => {
      await client.query(
        "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
        [providerId, "api_key", providerKey, displayName, true],
      );
    },
  });
}

async function expectAfterReload(
  page: Page,
  baseUrl: string,
  assertion: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await page.goto(baseUrl);
    await assertion();
  }).toPass({ timeout: 20_000 });
}

async function readHealth(baseUrl: string): Promise<{ configVersion?: number } | null> {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (response.status !== 200) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
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
        message: "Console did not start.",
        timeout: 15_000,
      },
    )
    .toBe(200);
}

function startGatewayProcess(options: {
  databaseUrl: string;
  gatewayInstanceId: string;
  heartbeatIntervalMs: number;
  port: number;
  reconcileIntervalMs: number;
}): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "true",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: String(options.reconcileIntervalMs),
      GATEWAY_HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs),
      GATEWAY_INSTANCE_ID: options.gatewayInstanceId,
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: "test-master-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gateway: GatewayProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => gateway.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => gateway.stdout.push(String(chunk)));
  return gateway;
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  gateway.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    gateway.child.once("exit", () => resolve());
    setTimeout(() => {
      if (gateway.child.exitCode === null) {
        gateway.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
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
