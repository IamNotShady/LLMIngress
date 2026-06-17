import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("provider template selector lists categories fixed capabilities and rejects arbitrary endpoints", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_selector_${randomUUID().replaceAll("-", "_")}`,
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

          await openDisclosure(page, "Add from template");
          const remoteTemplates = page.getByRole("group", {
            name: "Remote API-key templates",
          });
          const deepSeekTemplate = remoteTemplates.locator(".provider-template-card").filter({
            has: page.getByRole("heading", { name: "DeepSeek" }),
          });
          await expect(deepSeekTemplate.getByRole("heading", { name: "DeepSeek" })).toBeVisible();
          await expect(
            deepSeekTemplate.getByText("Fixed base URL: https://api.deepseek.com"),
          ).toBeVisible();
          await expect(
            deepSeekTemplate.getByText("Auth: Authorization Bearer API key"),
          ).toBeVisible();
          await expect(
            deepSeekTemplate.getByText("Capabilities: Chat completions, Streaming, Tools"),
          ).toBeVisible();

          const localTemplates = page.getByRole("group", { name: "Local templates" });
          const ollamaTemplate = localTemplates.locator(".provider-template-card").filter({
            has: page.getByRole("heading", { name: "Ollama" }),
          });
          await expect(ollamaTemplate.getByRole("heading", { name: "Ollama" })).toBeVisible();
          await expect(
            ollamaTemplate.getByText("Base URL: user-provided local/private URL"),
          ).toBeVisible();
          await expect(ollamaTemplate.getByText("Model list path: /api/tags")).toBeVisible();
          await expect(ollamaTemplate.getByText("Chat path: /api/chat")).toBeVisible();
          await expect(ollamaTemplate.getByText("Capabilities: Chat completions")).toBeVisible();

          await page.getByLabel("Provider template").selectOption("deepseek");
          await page.getByRole("button", { name: "Add template provider" }).click();

          const providerList = page.locator(".row-list");
          await expect(providerList.getByRole("heading", { name: "DeepSeek" })).toBeVisible();
          await openRow(page, "DeepSeek");
          await expect(
            providerList.getByText("Template provider base URL: https://api.deepseek.com"),
          ).toBeVisible();

          const customCreate = await postProviderForm(page, {
            action: "createFromTemplate",
            baseUrl: "https://arbitrary.example/v1",
            templateId: "deepseek",
          });
          expect(customCreate.status).toBe(400);
          expect(customCreate.body).toMatchObject({
            error: expect.stringMatching(/custom OpenAI-compatible endpoints are not allowed/i),
          });

          const legacyCustomCreate = await postProviderForm(page, {
            action: "create",
            baseUrl: "https://arbitrary.example/v1",
            displayName: "Custom",
            providerKey: "custom",
            providerType: "api_key",
          });
          expect(legacyCustomCreate.status).toBe(400);
          expect(legacyCustomCreate.body).toMatchObject({
            error: expect.stringMatching(/custom OpenAI-compatible endpoints are not allowed/i),
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

async function postProviderForm(
  page: Page,
  form: Record<string, string>,
): Promise<{ body: unknown; status: number }> {
  return page.evaluate(async (formInput) => {
    const response = await fetch("/api/providers", {
      body: new URLSearchParams(formInput),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    return {
      body:
        response.headers.get("content-type")?.includes("application/json") === true
          ? await response.json()
          : null,
      status: response.status,
    };
  }, form);
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
