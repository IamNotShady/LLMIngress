import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createOllamaProviderAdapter } from "../../apps/gateway/src/provider-adapters/ollama";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

test("ollama loopback private network url accepted template paths used public url requires confirmation", async ({
  browser,
}) => {
  const server = await createFakeProviderServer();
  const adapter = createOllamaProviderAdapter();
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_ollama_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const models = await adapter.listModels({
      target: {
        baseUrl: server.url,
      },
    });
    const chat = await adapter.chat({
      request: {
        messages: [{ role: "user", content: "Say hi" }],
        stream: false,
      },
      target: {
        baseUrl: server.url,
        modelId: "llama3.2",
      },
    });

    expect(models).toMatchObject({
      body: { models: [{ name: "llama3.2:latest" }] },
      ok: true,
      statusCode: 200,
    });
    expect(chat).toMatchObject({
      body: { message: { content: "fake provider response" } },
      ok: true,
      statusCode: 200,
    });
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/tags",
    });
    expect(server.requests[1]).toMatchObject({
      bodyJson: {
        messages: [{ role: "user", content: "Say hi" }],
        model: "llama3.2",
        stream: false,
      },
      method: "POST",
      path: "/api/chat",
    });

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

          const publicCreate = await postProviderForm(page, {
            action: "createFromTemplate",
            baseUrl: "https://ollama.example.com",
            templateId: "ollama",
          });
          expect(publicCreate.status).toBe(400);
          expect(publicCreate.body).toMatchObject({
            error: expect.stringMatching(/public network.*risk confirmation/i),
          });

          const legacyOllamaCreate = await postProviderForm(page, {
            action: "create",
            baseUrl: server.url,
            displayName: "Ollama",
            providerKey: "ollama",
            providerType: "local",
          });
          expect(legacyOllamaCreate.status).toBe(400);
          expect(legacyOllamaCreate.body).toMatchObject({
            error: expect.stringMatching(/ollama.*template/i),
          });

          const legacyCustomLocalCreate = await postProviderForm(page, {
            action: "create",
            baseUrl: server.url,
            displayName: "Custom Local",
            providerKey: "myollama",
            providerType: "local",
          });
          expect(legacyCustomLocalCreate.status).toBe(400);
          expect(legacyCustomLocalCreate.body).toMatchObject({
            error: expect.stringMatching(/local providers.*template/i),
          });

          const loopbackCreate = await postProviderForm(page, {
            action: "createFromTemplate",
            baseUrl: server.url,
            templateId: "ollama",
          });
          expect(loopbackCreate.status).toBe(200);

          const providers = await readOllamaProviders(fixture);
          expect(providers).toEqual([
            {
              base_url: server.url,
              display_name: "Ollama",
              provider_key: "ollama",
              provider_template_id: "ollama",
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

type OllamaProviderRow = {
  base_url: string;
  display_name: string;
  provider_key: string;
  provider_template_id: string;
  provider_type: string;
};

async function readOllamaProviders(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<OllamaProviderRow[]> {
  const result = await fixture.query<OllamaProviderRow>(
    `
      select provider_type, provider_key, display_name, base_url, provider_template_id
      from providers
      where provider_template_id = 'ollama'
      order by provider_key
    `,
  );
  return result.rows;
}

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
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
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
