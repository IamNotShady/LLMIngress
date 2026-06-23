import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openRow } from "../support/console-ui";
import { withProcessLock } from "../support/process-lock";

test("config import export redacts secrets validates publishes config version and round trips supported configuration", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_config_import_export_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedConfigExportData(fixture);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await page.goto(`${baseUrl}/settings`);

          const settingsSection = page.getByRole("region", { name: "Settings" });
          await expect(
            settingsSection.getByRole("heading", { name: "Data", exact: true }),
          ).toBeVisible();

          const downloadPromise = page.waitForEvent("download");
          await settingsSection.getByRole("link", { name: "Export redacted config" }).click();
          const download = await downloadPromise;
          const downloadPath = await download.path();
          expect(downloadPath).not.toBeNull();
          const exportedRaw = await readFile(downloadPath ?? "", "utf8");
          expect(exportedRaw).toContain("redacted");
          expect(exportedRaw).toContain("Config Export DeepSeek");
          expect(exportedRaw).not.toContain("ciphertext-config-export-e2e-080");
          expect(exportedRaw).not.toContain("sha256:v1:config-export-e2e-secret-hash-080");

          const exported = JSON.parse(exportedRaw) as {
            agents: Array<Record<string, unknown>>;
          };
          exported.agents.push({
            agentType: "coding",
            apiKey: null,
            enabled: true,
            id: randomUUID(),
            name: "Imported Config Agent",
          });

          await settingsSection
            .getByLabel("Config import JSON")
            .fill(JSON.stringify(exported, null, 2));
          await settingsSection.getByRole("button", { name: "Import redacted config" }).click();

          await expect(page.getByText(/Config import published version v\d+/)).toBeVisible();
          await page.goto(`${baseUrl}/agents`);
          await expect(page.locator("table.agents-table")).toContainText("Imported Config Agent");
          await page.goto(`${baseUrl}/providers`);
          await openRow(page, "Config Export DeepSeek");
          await expect(page.getByRole("row", { name: /- 100 Unknown/ })).toBeVisible();
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

async function seedConfigExportData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    providerApiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    routePolicyId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (
        id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled
      )
      values ($1, 'api_key', 'deepseek', 'deepseek', 'Config Export DeepSeek',
              'https://api.deepseek.com', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id, provider_id, model_id, display_name, context_window, supports_streaming,
        supports_tools, availability
      )
      values ($1, $2, 'deepseek-chat', 'DeepSeek Chat', 64000, true, true, 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (
        id, provider_id, key_prefix, encrypted_key, key_id
      )
      values ($1, $2, 'sk-cfg80',
              '{"ciphertext":"ciphertext-config-export-e2e-080","iv":"iv","tag":"tag"}'::jsonb,
              'provider-key-id-e2e-080')
    `,
    [ids.providerApiKeyId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'config-e2e', 'Config E2E', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
    [ids.routePolicyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id, route_policy_id, provider_model_id, candidate_order, is_fallback
      )
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), ids.routePolicyId, ids.providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Config Export Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_cfg80', key_hash = 'sha256:v1:config-export-e2e-secret-hash-080', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [ids.agentApiKeyId, ids.virtualModelId],
  );
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
      { message: "Console did not start.", timeout: 15_000 },
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
