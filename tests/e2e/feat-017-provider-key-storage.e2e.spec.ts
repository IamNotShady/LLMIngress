import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("provider key plaintext once and repeated saves add multiple stored keys", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_key_${randomUUID().replaceAll("-", "_")}`,
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
        const firstSecret = "sk-live-provider-secret-017";
        const secondSecret = "sk-second-provider-secret-017";

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await page.goto(`${baseUrl}/providers`);

          await openDisclosure(page, "New provider");
          await page.getByLabel("Provider type", { exact: true }).selectOption({ label: "OpenAI" });
          await page.getByLabel("Provider display name").fill("OpenAI");
          await page.getByRole("button", { name: "Create provider" }).click();
          await expect(page.getByRole("row", { name: /OpenAI/ })).toBeVisible();

          await saveProviderApiKey(page, "OpenAI", firstSecret, {
            label: "Primary provider key",
            priority: "5",
          });

          await expect(page.getByRole("heading", { name: "Provider API key saved" })).toBeVisible();
          await expect(page.getByText(firstSecret)).toBeVisible();

          const createdRows = await readProviderKeyRows(fixture);
          expect(createdRows).toHaveLength(1);
          expect(createdRows[0]).toMatchObject({
            encrypted_contains_first_secret: false,
            encrypted_contains_second_secret: false,
            has_created_at: true,
            has_rotated_at: false,
            key_prefix: "sk-live-",
            provider_key: "openai",
          });

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(firstSecret)).toHaveCount(0);
          await openRow(page, "OpenAI");
          await expect(
            page.getByRole("cell", { exact: true, name: "Primary provider key" }),
          ).toBeVisible();
          await expect(page.getByRole("cell", { exact: true, name: "5" })).toBeVisible();
          await expect(page.getByRole("cell", { exact: true, name: "sk-live-" })).toHaveCount(0);

          await page.reload();
          await expect(page.getByText(firstSecret)).toHaveCount(0);
          await openRow(page, "OpenAI");
          await expect(
            page.getByRole("cell", { exact: true, name: "Primary provider key" }),
          ).toBeVisible();
          await expect(page.getByRole("cell", { exact: true, name: "5" })).toBeVisible();
          await expect(page.getByRole("cell", { exact: true, name: "sk-live-" })).toHaveCount(0);

          await saveProviderApiKey(page, "OpenAI", secondSecret, {
            label: "Fallback provider key",
            priority: "10",
          });

          await expect(page.getByRole("heading", { name: "Provider API key saved" })).toBeVisible();
          await expect(page.getByText(secondSecret)).toBeVisible();

          const savedRows = await readProviderKeyRows(fixture);
          expect(savedRows).toHaveLength(2);
          expect(savedRows).toEqual([
            expect.objectContaining({
              encrypted_contains_first_secret: false,
              encrypted_contains_second_secret: false,
              has_created_at: true,
              has_rotated_at: false,
              key_prefix: "sk-live-",
              provider_key: "openai",
            }),
            expect.objectContaining({
              encrypted_contains_first_secret: false,
              encrypted_contains_second_secret: false,
              has_created_at: true,
              has_rotated_at: false,
              key_prefix: "sk-secon",
              provider_key: "openai",
            }),
          ]);

          await page.getByRole("link", { name: "Back to dashboard" }).click();
          await expect(page.getByText(firstSecret)).toHaveCount(0);
          await expect(page.getByText(secondSecret)).toHaveCount(0);
          await openRow(page, "OpenAI");
          await expect(
            page.getByRole("cell", { exact: true, name: "Primary provider key" }),
          ).toBeVisible();
          await expect(
            page.getByRole("cell", { exact: true, name: "Fallback provider key" }),
          ).toBeVisible();
          await expect(page.getByRole("cell", { exact: true, name: "sk-live-" })).toHaveCount(0);
          await expect(page.getByRole("cell", { exact: true, name: "sk-secon" })).toHaveCount(0);
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

type ProviderKeyStorageRow = {
  encrypted_contains_first_secret: boolean;
  encrypted_contains_second_secret: boolean;
  has_created_at: boolean;
  has_rotated_at: boolean;
  key_prefix: string;
  provider_key: string;
};

async function saveProviderApiKey(
  page: Page,
  providerName: string,
  plaintext: string,
  metadata: { label: string; priority: string },
): Promise<void> {
  await openRow(page, providerName);
  await page.getByRole("link", { name: "Add API key" }).click();
  await page
    .getByRole("dialog", { name: /API key/ })
    .getByRole("textbox", { name: "Provider API key" })
    .fill(plaintext);
  await page.getByLabel("Label").fill(metadata.label);
  await page.getByLabel("Priority").fill(metadata.priority);
  await page.getByRole("button", { name: "Save API key" }).click();
}

async function readProviderKeyRows(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<ProviderKeyStorageRow[]> {
  const result = await fixture.query<ProviderKeyStorageRow>(
    `
      select p.provider_key,
             k.key_prefix,
             k.created_at is not null as has_created_at,
             k.rotated_at is not null as has_rotated_at,
             k.encrypted_key::text like '%sk-live-provider-secret-017%' as encrypted_contains_first_secret,
             k.encrypted_key::text like '%sk-second-provider-secret-017%' as encrypted_contains_second_secret
      from provider_api_keys k
      join providers p on p.id = k.provider_id
      order by p.provider_key, k.created_at, k.id
    `,
  );
  return result.rows;
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
  let lastBody = "";

  try {
    await expect
      .poll(
        async () => {
          if (consoleApp.child.exitCode !== null) {
            return `exited:${consoleApp.child.exitCode}`;
          }

          try {
            const response = await fetch(baseUrl);
            if (response.status !== 200) {
              lastBody = (await response.text()).slice(0, 2_000);
            }
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
  } catch (error) {
    throw new Error(
      [
        "Console did not start.",
        `stdout:\n${consoleApp.stdout.join("")}`,
        `stderr:\n${consoleApp.stderr.join("")}`,
        `body:\n${lastBody}`,
      ].join("\n\n"),
      { cause: error },
    );
  }
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
