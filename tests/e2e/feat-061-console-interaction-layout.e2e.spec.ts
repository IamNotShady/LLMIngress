import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

const masterKey = "test-master-key";

test("dashboard form labels stay paired with their controls on desktop", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_layout_${randomUUID().replaceAll("-", "_")}`,
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
        const context = await browser.newContext({ viewport: { height: 720, width: 1280 } });
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);

          await page.goto(`${baseUrl}/playground`);
          const playgroundFields = await readFieldLayout(page, [
            "playground-gateway-base-url",
            "playground-agent-api-key",
            "playground-model",
            "playground-prompt",
          ]);
          for (const field of playgroundFields) {
            expectFieldToBePaired(field);
          }

          await page.goto(`${baseUrl}/providers`);
          await openDisclosure(page, "New provider");
          const createDialog = page.getByRole("dialog", { name: "添加 Provider" });
          await expect(createDialog).toBeVisible();
          await expect(page.getByLabel("Provider type", { exact: true })).toBeVisible();
          await page.getByRole("tab", { name: "API Keys" }).click();
          await expect(page.getByLabel("Provider base URL")).toBeVisible();

          const providerFields = await readFieldLayout(page, [
            "provider-choice",
            "provider-display-name",
            "provider-base-url",
          ]);
          for (const field of providerFields) {
            expectFieldToBePaired(field);
          }

          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(1280);
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

type FieldLayout = {
  control: Rect | null;
  id: string;
  label: Rect | null;
};

type Rect = {
  bottom: number;
  height: number;
  width: number;
  x: number;
  y: number;
};

function expectFieldToBePaired(field: FieldLayout): void {
  expect(field.label, `${field.id} label`).not.toBeNull();
  expect(field.control, `${field.id} control`).not.toBeNull();
  const label = field.label as Rect;
  const control = field.control as Rect;

  expect(Math.abs(label.x - control.x), `${field.id} horizontal alignment`).toBeLessThanOrEqual(2);
  expect(label.y, `${field.id} label vertical position`).toBeLessThan(control.y);
  expect(control.y - label.bottom, `${field.id} label/control gap`).toBeLessThanOrEqual(12);
  expect(control.width, `${field.id} control width`).toBeGreaterThan(240);
}

async function readFieldLayout(page: Page, ids: string[]): Promise<FieldLayout[]> {
  return page.evaluate((fieldIds) => {
    function rect(element: Element | null): Rect | null {
      if (!element) {
        return null;
      }
      const box = element.getBoundingClientRect();
      return {
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        width: Math.round(box.width),
        x: Math.round(box.x),
        y: Math.round(box.y),
      };
    }

    return fieldIds.map((id) => ({
      control: rect(document.getElementById(id)),
      id,
      label: rect(document.querySelector(`label[for="${id}"]`)),
    }));
  }, ids);
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
    }, 2_000).unref();
  });
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
