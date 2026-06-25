import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

const gatewayBaseUrl = "http://127.0.0.1:4100";
const integrationTemplateNames = ["Codex", "Claude Code", "Cursor", "OpenClaw"] as const;

test("agent integration templates show codex claude code cursor openclaw gateway url api key and model snippets", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_integrations_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const virtualModel = await seedIntegrationVirtualModel(fixture);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        gatewayBaseUrl,
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
          const virtualModelLabel = virtualModel.name;
          await page.getByLabel("Agent name").fill("Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page
            .getByLabel("Allowed virtual models")
            .selectOption({ label: virtualModelLabel });
          await page.getByLabel("Default virtual model").selectOption({ label: virtualModelLabel });
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
          const plaintextKey = await page.locator("code").innerText();
          expect(plaintextKey).toMatch(/^llmi_[A-Za-z0-9_-]{32,}$/);

          for (const templateName of integrationTemplateNames) {
            const snippet = page.getByLabel(`${templateName} setup snippet`);
            await expect(snippet).toBeVisible();
            await expect(snippet).toHaveValue(
              new RegExp(`Gateway URL: ${escapeRegExp(gatewayBaseUrl)}`),
            );
            await expect(snippet).toHaveValue(new RegExp(`API key: ${escapeRegExp(plaintextKey)}`));
            await expect(snippet).toHaveValue(/Model: <Virtual Model Name>/);
            expect(
              await snippet.evaluate((element) => (element as HTMLTextAreaElement).readOnly),
            ).toBe(true);
          }

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(plaintextKey)).toHaveCount(0);

          const dashboardPlaceholder = `paste one-time Agent API key for prefix ${plaintextKey.slice(
            0,
            12,
          )}`;
          await expect(
            page.getByLabel("Selected agent details").getByRole("heading", { name: "Codex" }),
          ).toBeVisible();
          await expect(page.getByLabel("Selected agent details")).toContainText(virtualModel.name);
          for (const templateName of integrationTemplateNames) {
            const snippet = page.getByLabel(`${templateName} setup snippet`);
            await expect(snippet).toBeVisible();
            await expect(snippet).toHaveValue(
              new RegExp(`Gateway URL: ${escapeRegExp(gatewayBaseUrl)}`),
            );
            await expect(snippet).toHaveValue(
              new RegExp(`API key: ${escapeRegExp(dashboardPlaceholder)}`),
            );
            await expect(snippet).toHaveValue(new RegExp(`Model: ${virtualModel.name}`));
            expect(
              await snippet.evaluate((element) => (element as HTMLTextAreaElement).readOnly),
            ).toBe(true);
          }
          await expect(page.getByText(plaintextKey)).toHaveCount(0);
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

async function seedIntegrationVirtualModel(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<{ description: string; id: string; name: string }> {
  const virtualModel = {
    description: "Integration VM",
    id: randomUUID(),
    name: "integration-vm",
  };
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
    [virtualModel.id, virtualModel.name, virtualModel.description],
  );
  return virtualModel;
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

function startConsoleProcess(options: {
  databaseUrl: string;
  gatewayBaseUrl: string;
  port: number;
}): ConsoleProcess {
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
        GATEWAY_PUBLIC_BASE_URL: options.gatewayBaseUrl,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
