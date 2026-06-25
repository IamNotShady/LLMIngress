import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure } from "../support/console-ui";
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
          const providerType = page.getByLabel("Provider type", { exact: true });
          await expect(providerType).toContainText("OpenAI");
          await expect(providerType).toContainText("Anthropic");
          await expect(providerType).toContainText("OpenRouter");
          await expect(providerType).toContainText("DeepSeek");
          await expect(providerType).not.toContainText("Ollama");

          await page.getByRole("tab", { name: "Local" }).click();
          await expect(providerType).toContainText("Ollama");
          await page.getByRole("tab", { name: "API Keys" }).click();

          await providerType.selectOption({ label: "DeepSeek" });
          await expect(page.getByLabel("Provider display name")).toHaveValue("DeepSeek");
          await expect(page.getByLabel("Provider base URL")).toHaveAttribute(
            "placeholder",
            "https://api.deepseek.com",
          );
          await page.getByRole("button", { name: "Create provider" }).click();
          await expect(page.getByRole("row", { name: /DeepSeek/ })).toBeVisible();

          const customCreate = await postProviderForm(page, {
            action: "createFromTemplate",
            baseUrl: "https://arbitrary.example/v1",
            templateId: "deepseek",
          });
          expect(customCreate).toMatchObject({
            error: expect.stringMatching(/custom OpenAI-compatible endpoints are not allowed/i),
            status: 200,
          });

          const legacyCustomCreate = await postProviderForm(page, {
            action: "create",
            baseUrl: "https://arbitrary.example/v1",
            displayName: "Custom",
            providerKey: "custom",
            providerType: "api_key",
          });
          expect(legacyCustomCreate).toMatchObject({
            error: expect.stringMatching(/custom OpenAI-compatible endpoints are not allowed/i),
            status: 200,
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
): Promise<{ error: string | null; status: number; url: string }> {
  return page.evaluate(async (formInput) => {
    const response = await fetch("/api/providers", {
      body: new URLSearchParams(formInput),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const url = new URL(response.url);

    return {
      error: url.searchParams.get("providerError"),
      status: response.status,
      url: response.url,
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
