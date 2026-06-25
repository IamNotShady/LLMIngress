import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("agent crud works and delete with request attribution soft-deletes", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_crud_${randomUUID().replaceAll("-", "_")}`,
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
          await page.goto(`${baseUrl}/agents`);

          await openDisclosure(page, "New agent");
          await page.getByLabel("Agent name").fill("Codex");
          await page.getByLabel("Agent type").selectOption("coding");
          await page.getByRole("button", { name: "Create agent" }).click();
          await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
          await page.getByRole("link", { name: "Back to dashboard" }).click();

          await expect(page.getByRole("row", { name: /Codex CLI/ })).toBeVisible();

          await openRow(page, "Codex");
          await page.getByLabel("Edit agent name").fill("Codex CLI");
          await page.getByLabel("Edit agent type").selectOption("terminal");
          await page.getByRole("button", { exact: true, name: "Save" }).click();

          await expect(page.getByRole("row", { name: /Codex CLI Terminal/ })).toBeVisible();

          await page
            .getByRole("row", { name: /Codex CLI Terminal/ })
            .getByRole("link", { name: "Delete" })
            .click();
          await page.getByRole("button", { name: "Delete" }).click();
          await expect(page.getByText("No agents yet")).toBeVisible();

          const protectedAgents = await insertProtectedAgents(fixture);
          await page.reload();
          await expect(page.getByRole("row", { name: /Active Key Agent/ })).toBeVisible();
          await expect(page.getByRole("row", { name: /Attributed Agent/ })).toBeVisible();

          await deleteAgentByApi(page, protectedAgents.attributedAgentId);
          await page.reload();
          await expect(page.getByRole("row", { name: /Attributed Agent/ })).toHaveCount(0);
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

type ProtectedAgents = {
  attributedAgentId: string;
};

async function insertProtectedAgents(fixture: Fixture): Promise<ProtectedAgents> {
  const activeKeyAgentId = randomUUID();
  const attributedAgentId = randomUUID();

  await fixture.query(
    `
      insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
      values ($1, 'Active Key Agent', 'coding', 'active26', 'hash-active-26', true),
             ($2, 'Attributed Agent', 'desktop', 'attr26', 'hash-attributed-26', false)
    `,
    [activeKeyAgentId, attributedAgentId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        agent_key_prefix,
        protocol,
        status
      )
      values ($1, $2, $3, 'attr26', 'chat_completions', 'succeeded')
    `,
    [randomUUID(), `request-${randomUUID()}`, attributedAgentId],
  );

  return { attributedAgentId };
}

async function deleteAgentByApi(page: Page, agentId: string): Promise<void> {
  const result = await page.evaluate(
    async ({ id }) => {
      const body = new FormData();
      body.set("action", "delete");
      body.set("id", id);
      const response = await fetch("/api/agents", {
        body,
        method: "POST",
        redirect: "manual",
      });
      return {
        status: response.status,
      };
    },
    { id: agentId },
  );

  expect([0, 303]).toContain(result.status);
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
