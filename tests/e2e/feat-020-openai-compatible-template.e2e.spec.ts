import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("whitelisted template accepted arbitrary custom endpoint rejected", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_openai_template_${randomUUID().replaceAll("-", "_")}`,
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

          const createResult = await postProviderForm(page, {
            action: "createFromTemplate",
            templateId: "deepseek",
          });
          expect(createResult).toMatchObject({ error: null, status: 200 });

          const providers = await readTemplateProviders(fixture);
          expect(providers).toEqual([
            {
              base_url: "https://api.deepseek.com",
              display_name: "DeepSeek",
              provider_key: "deepseek",
              provider_template_id: "deepseek",
            },
          ]);

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

          const customUpdate = await postProviderForm(page, {
            action: "update",
            baseUrl: "https://arbitrary.example/v1",
            displayName: "DeepSeek",
            id: await readDeepSeekProviderId(fixture),
          });
          expect(customUpdate).toMatchObject({
            error: expect.stringMatching(/template provider base URL cannot be changed/i),
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

type TemplateProviderRow = {
  base_url: string;
  display_name: string;
  provider_key: string;
  provider_template_id: string;
};

async function readTemplateProviders(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<TemplateProviderRow[]> {
  const result = await fixture.query<TemplateProviderRow>(
    `
      select provider_key, display_name, base_url, provider_template_id
      from providers
      where provider_template_id is not null
      order by provider_key
    `,
  );
  return result.rows;
}

async function readDeepSeekProviderId(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text from providers where provider_key = 'deepseek'",
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("DeepSeek provider was not created.");
  }
  return id;
}

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
