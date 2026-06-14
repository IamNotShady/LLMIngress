import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("virtual model crud rejects duplicate name and blocks referenced delete", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_virtual_model_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

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

          await page.getByRole("textbox", { name: "Virtual model name" }).fill("Coding Fast");
          await page
            .getByRole("textbox", { name: "Virtual model display name" })
            .fill("Coding Fast");
          await page.getByRole("button", { name: "Create virtual model" }).click();

          await expect(page.getByRole("heading", { name: "Coding Fast" })).toBeVisible();
          await expect(page.getByText("coding-fast")).toBeVisible();

          await expectVirtualModelActionError(page, {
            action: "create",
            displayName: "Duplicate",
            errorPattern: /duplicate|already exists/i,
            name: "coding-fast",
          });

          await page
            .getByRole("textbox", { name: "Edit virtual model name" })
            .fill("coding-balanced");
          await page
            .getByRole("textbox", { name: "Edit virtual model display name" })
            .fill("Coding Balanced");
          await page.getByRole("button", { name: "Save virtual model" }).click();

          await expect(page.getByRole("heading", { name: "Coding Balanced" })).toBeVisible();
          await expect(page.getByText("coding-balanced")).toBeVisible();

          await page.getByRole("button", { name: "Delete virtual model" }).click();
          await expect(page.getByText("No virtual models configured.")).toBeVisible();

          const referencedVirtualModelId = await insertReferencedVirtualModel(fixture);
          await page.reload();
          await expect(page.getByRole("heading", { name: "Referenced Model" })).toBeVisible();

          await expectVirtualModelActionError(page, {
            action: "delete",
            errorPattern: /route policy/i,
            id: referencedVirtualModelId,
          });
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

type VirtualModelActionInput =
  | {
      action: "create";
      displayName: string;
      errorPattern: RegExp;
      name: string;
    }
  | {
      action: "delete";
      errorPattern: RegExp;
      id: string;
    };

async function insertReferencedVirtualModel(fixture: Fixture): Promise<string> {
  const virtualModelId = randomUUID();
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'referenced-model', 'Referenced Model', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [randomUUID(), virtualModelId],
  );
  return virtualModelId;
}

async function expectVirtualModelActionError(
  page: Page,
  input: VirtualModelActionInput,
): Promise<void> {
  const result = await page.evaluate(async (actionInput) => {
    const body = new FormData();
    body.set("action", actionInput.action);
    if (actionInput.action === "create") {
      body.set("name", actionInput.name);
      body.set("displayName", actionInput.displayName);
    } else {
      body.set("id", actionInput.id);
    }

    const response = await fetch("/api/virtual-models", { body, method: "POST" });
    return {
      body: await response.json(),
      status: response.status,
    };
  }, input);

  expect(result.status).toBe(400);
  expect(result.body).toEqual({ error: expect.stringMatching(input.errorPattern) });
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
