import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { createOpenAIProviderAdapter } from "../../apps/gateway/src/provider-adapters/openai";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure } from "../support/console-ui";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

const remoteTemplateExpectations = [
  ["deepseek", "DeepSeek", "https://api.deepseek.com"],
  ["xai", "xAI", "https://api.x.ai/v1"],
  ["mistral", "Mistral", "https://api.mistral.ai/v1"],
  ["qwen", "Qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  ["moonshot", "Moonshot/Kimi", "https://api.moonshot.ai/v1"],
  ["minimax", "MiniMax", "https://api.minimax.io/v1"],
  ["groq", "Groq", "https://api.groq.com/openai/v1"],
  ["fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1"],
  ["zai", "Z.ai", "https://api.z.ai/api/paas/v4"],
] as const;

test("all nine remote templates expose fixed urls capabilities auth behavior and representative generic adapter request works", async ({
  browser,
}) => {
  const provider = await createFakeProviderServer();
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_remote_templates_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const adapter = createOpenAIProviderAdapter();
    const representative = await adapter.chatCompletion({
      request: {
        messages: [{ role: "user", content: "Say hi through a long-tail template" }],
        stream: false,
      },
      target: {
        apiKey: "sk-remote-template-e2e",
        baseUrl: `${provider.url}/openai/v1`,
        modelId: "llmingress-template-smoke",
      },
    });

    expect(representative).toMatchObject({
      body: {
        choices: [{ message: { content: "fake provider response" } }],
        id: "fake-provider-response",
      },
      ok: true,
      providerRequestId: "fake-provider-response",
      statusCode: 200,
    });
    expect(provider.requests[0]).toMatchObject({
      bodyJson: {
        messages: [{ role: "user", content: "Say hi through a long-tail template" }],
        model: "llmingress-template-smoke",
        stream: false,
      },
      method: "POST",
      path: "/openai/v1/chat/completions",
    });
    expect(provider.requests[0]?.headers.authorization).toBe("Bearer sk-remote-template-e2e");

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
          const dialog = page.getByRole("dialog", { name: "添加 Provider" });
          const providerType = dialog.getByLabel("Provider type");
          const displayNameInput = dialog.getByLabel("Provider display name");
          const baseUrlInput = dialog.getByLabel("Provider base URL");
          for (const [id, displayName, fixedBaseUrl] of remoteTemplateExpectations) {
            await expect(providerType).toContainText(displayName);
            await providerType.selectOption(id);
            await expect(displayNameInput).toHaveValue(displayName);
            await expect(baseUrlInput).toHaveValue(fixedBaseUrl);
          }

          await providerType.selectOption("groq");
          await dialog.getByRole("button", { name: "Create provider" }).click();

          await expect(page.locator("table.providers-table")).toContainText("Groq");

          const providers = await readTemplateProviders(fixture);
          expect(providers).toEqual([
            {
              base_url: "https://api.groq.com/openai/v1",
              display_name: "Groq",
              provider_key: "groq",
              provider_template_id: "groq",
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
    await provider.close();
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

async function signInFromFirstRun(page: import("@playwright/test").Page, baseUrl: string) {
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
