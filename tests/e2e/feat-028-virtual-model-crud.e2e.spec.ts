import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { type BrowserContext, expect, test } from "@playwright/test";
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
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await page.goto(`${baseUrl}/models`);

          await page.getByRole("link", { name: "+ 创建 Virtual Model" }).click();
          await expect(page.getByRole("dialog", { name: "创建 Virtual Model" })).toBeVisible();
          await page.getByRole("textbox", { name: "Virtual Model 名称" }).fill("Coding Fast");
          await page.getByRole("textbox", { name: "描述" }).fill("Coding Fast");
          await page.getByRole("button", { name: "保存" }).click();

          await expect(page.getByRole("link", { name: "coding-fast" })).toBeVisible();

          await expectVirtualModelActionError(baseUrl, context, {
            action: "create",
            description: "Duplicate",
            errorPattern: /duplicate|already exists/i,
            name: "coding-fast",
          });

          await page
            .getByRole("row", { name: /coding-fast/ })
            .getByRole("link", { name: "编辑" })
            .click();
          await expect(page.getByRole("dialog", { name: /编辑 Virtual Model/ })).toBeVisible();
          await page.getByRole("textbox", { name: "Virtual Model 名称" }).fill("coding-balanced");
          await page.getByRole("textbox", { name: "描述" }).fill("Coding Balanced");
          await page.getByRole("button", { name: "保存" }).click();

          await expect(page.getByRole("link", { name: "coding-balanced" })).toBeVisible();

          const balancedVirtualModelId = await readVirtualModelId(fixture, "coding-balanced");
          await expectVirtualModelActionSuccess(baseUrl, context, {
            action: "delete",
            id: balancedVirtualModelId,
          });
          await page.reload();
          await expect(page.getByText("No virtual models configured.")).toBeVisible();

          const referencedVirtualModelId = await insertReferencedVirtualModel(fixture);
          await page.reload();
          await expect(page.getByRole("link", { name: "referenced-model" })).toBeVisible();

          await expectVirtualModelActionError(baseUrl, context, {
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
      description: string;
      errorPattern: RegExp;
      name: string;
    }
  | {
      action: "delete";
      errorPattern: RegExp;
      id: string;
    };

type SuccessfulVirtualModelActionInput = {
  action: "delete";
  id: string;
};

async function insertReferencedVirtualModel(fixture: Fixture): Promise<string> {
  const virtualModelId = randomUUID();
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
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
  baseUrl: string,
  context: BrowserContext,
  input: VirtualModelActionInput,
): Promise<void> {
  const result = await postVirtualModelAction(baseUrl, context, input);
  expect(result.status).toBe(400);
  expect(result.body).toEqual({ error: expect.stringMatching(input.errorPattern) });
}

async function expectVirtualModelActionSuccess(
  baseUrl: string,
  context: BrowserContext,
  input: SuccessfulVirtualModelActionInput,
): Promise<void> {
  const result = await postVirtualModelAction(baseUrl, context, input);
  expect(result.status).toBe(303);
}

async function postVirtualModelAction(
  baseUrl: string,
  context: BrowserContext,
  input: VirtualModelActionInput | SuccessfulVirtualModelActionInput,
): Promise<{ body: unknown; status: number }> {
  const body = new URLSearchParams();
  body.set("action", input.action);
  if (input.action === "create") {
    body.set("name", input.name);
    body.set("description", input.description);
  } else {
    body.set("id", input.id);
  }
  const cookies = await context.cookies(baseUrl);
  const response = await fetch(`${baseUrl}/api/virtual-models`, {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    },
    method: "POST",
    redirect: "manual",
  });
  const responseText = await response.text();
  return {
    body: responseText ? JSON.parse(responseText) : null,
    status: response.status,
  };
}

async function readVirtualModelId(fixture: Fixture, name: string): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text from virtual_models where name = $1",
    [name],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Virtual Model ${name} was not found.`);
  }
  return row.id;
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
