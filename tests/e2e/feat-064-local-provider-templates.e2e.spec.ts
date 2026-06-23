import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import { openDisclosure } from "../support/console-ui";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

test("local provider templates accept configured urls and use template paths", async ({
  browser,
}) => {
  const server = await createFakeProviderServer();
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_local_templates_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const adapter = createOpenAIProviderAdapter();
    const adapterResult = await adapter.chatCompletion({
      request: {
        messages: [{ role: "user", content: "Say hi from local template" }],
        stream: false,
      },
      target: {
        apiKey: "sk-local-template",
        baseUrl: `${server.url}/v1`,
        modelId: "local-template-model",
      },
    });

    expect(adapterResult).toMatchObject({
      ok: true,
      providerRequestId: "fake-provider-response",
      statusCode: 200,
    });
    expect(server.requests[0]).toMatchObject({
      bodyJson: {
        messages: [{ role: "user", content: "Say hi from local template" }],
        model: "local-template-model",
        stream: false,
      },
      method: "POST",
      path: "/v1/chat/completions",
    });

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
          const dialog = page.getByRole("dialog", { name: "Add Provider" });
          await dialog.getByRole("tab", { name: "Local" }).click();
          const providerType = dialog.getByLabel("Provider type", { exact: true });
          const displayNameInput = dialog.getByLabel("Provider display name");
          const baseUrlInput = dialog.getByLabel("Provider base URL");
          for (const [displayName, id, placeholder] of [
            ["LM Studio", "lmstudio", "http://127.0.0.1:1234/v1"],
            ["llama.cpp", "llama_cpp", "http://127.0.0.1:8080/v1"],
          ] as const) {
            await expect(providerType).toContainText(displayName);
            await providerType.selectOption(id);
            await expect(displayNameInput).toHaveValue(displayName);
            await expect(baseUrlInput).toHaveAttribute("placeholder", placeholder);
            await expect(dialog.getByRole("checkbox")).toHaveCount(0);
          }

          const loopbackCreate = await postProviderForm(page, {
            action: "createFromTemplate",
            baseUrl: `${server.url}/v1`,
            templateId: "lmstudio",
          });
          expect(loopbackCreate.status).toBe(200);
          expect(loopbackCreate.url).toMatch(/\/providers$/);

          const privateCreate = await postProviderForm(page, {
            action: "createFromTemplate",
            baseUrl: "http://192.168.1.25:8080/v1",
            templateId: "llama_cpp",
          });
          expect(privateCreate.status).toBe(200);
          expect(privateCreate.url).toMatch(/\/providers$/);

          const providers = await readLocalOpenAICompatibleProviders(fixture);
          expect(providers).toEqual([
            {
              base_url: "http://192.168.1.25:8080/v1",
              display_name: "llama.cpp",
              provider_key: "llama_cpp",
              provider_template_id: "llama_cpp",
              provider_type: "local",
            },
            {
              base_url: `${server.url}/v1`,
              display_name: "LM Studio",
              provider_key: "lmstudio",
              provider_template_id: "lmstudio",
              provider_type: "local",
            },
          ]);
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
    await server.close();
  }
});

type ConsoleProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type LocalOpenAICompatibleProviderRow = {
  base_url: string;
  display_name: string;
  provider_key: string;
  provider_template_id: string;
  provider_type: string;
};

async function readLocalOpenAICompatibleProviders(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<LocalOpenAICompatibleProviderRow[]> {
  const result = await fixture.query<LocalOpenAICompatibleProviderRow>(
    `
      select provider_type, provider_key, display_name, base_url, provider_template_id
      from providers
      where provider_template_id in ('lmstudio', 'llama_cpp')
      order by provider_key
    `,
  );
  return result.rows;
}

async function postProviderForm(
  page: Page,
  form: Record<string, string>,
): Promise<{ body: unknown; status: number; url: string }> {
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
