import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  buildMvpHappyPathModelOptionLabel,
  buildMvpHappyPathRequestId,
  mvpHappyPathNames,
} from "../support/mvp-happy-path";
import { withProcessLock } from "../support/process-lock";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-mvp-050";

test("clean setup request activity usage and hot reload after route change", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_mvp_happy_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const consoleBaseUrl = `http://127.0.0.1:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(consoleBaseUrl, consoleApp);
          await signInFromFirstRun(page, consoleBaseUrl);

          await configurePriceOverride(page);
          const modelOptions = await seedProviderAndModels(fixture, `${provider.url}/v1`);
          await page.reload();
          await expect(
            page.getByRole("heading", { exact: true, name: mvpHappyPathNames.providerDisplayName }),
          ).toBeVisible();
          await storeProviderApiKey(page);
          await createVirtualModelAndRoutePolicy(page, modelOptions.initial.optionLabel);
          const agentApiKey = await createAgentApiKeyWithAccessAndLimits(page);

          const gateway = startGatewayProcess({
            databaseUrl: fixture.databaseUrl,
            port: await getFreePort(),
          });

          try {
            const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`;
            await waitForGateway(gatewayBaseUrl, gateway);
            const gatewayPid = gateway.child.pid;

            await expectGatewayChat(gatewayBaseUrl, {
              agentApiKey,
              model: mvpHappyPathNames.virtualModelName,
              requestId: buildMvpHappyPathRequestId("initial"),
            });
            expect(readProviderRequestModels(provider.requests)).toEqual([
              mvpHappyPathNames.initialProviderModelId,
            ]);

            await page.reload();
            const activitySection = page.getByLabel("Activity");
            await expect(
              activitySection.getByRole("link", {
                name: buildMvpHappyPathRequestId("initial"),
              }),
            ).toBeVisible();
            await expect(page.getByLabel("Usage").getByText("Requests: 1")).toBeVisible();
            await expect(
              page.getByRole("heading", {
                exact: true,
                name: `${mvpHappyPathNames.providerDisplayName} / ${mvpHappyPathNames.initialProviderModelDisplayName}`,
              }),
            ).toBeVisible();

            await page
              .getByLabel("Edit primary provider models")
              .selectOption({ label: modelOptions.reloaded.optionLabel });
            await page.getByRole("button", { name: "Save route policy" }).click();
            await expect(
              page.getByText(`Primary: ${modelOptions.reloaded.optionLabel}`),
            ).toBeVisible();
            const targetConfigVersion = await readLatestConfigVersion(fixture);
            await waitForGatewayConfigVersion(gatewayBaseUrl, targetConfigVersion);
            expect(gateway.child.pid).toBe(gatewayPid);

            await expectGatewayChat(gatewayBaseUrl, {
              agentApiKey,
              model: mvpHappyPathNames.virtualModelName,
              requestId: buildMvpHappyPathRequestId("reloaded"),
            });
            expect(readProviderRequestModels(provider.requests)).toEqual([
              mvpHappyPathNames.initialProviderModelId,
              mvpHappyPathNames.reloadedProviderModelId,
            ]);

            await page.reload();
            await expect(
              page
                .getByLabel("Activity")
                .getByRole("link", { name: buildMvpHappyPathRequestId("reloaded") }),
            ).toBeVisible();
            await expect(page.getByLabel("Usage").getByText("Requests: 2")).toBeVisible();
            await expect(
              page.getByRole("heading", {
                exact: true,
                name: `${mvpHappyPathNames.providerDisplayName} / ${mvpHappyPathNames.reloadedProviderModelDisplayName}`,
              }),
            ).toBeVisible();
          } finally {
            await stopGatewayProcess(gateway);
          }
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await provider.close();
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

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type ProviderModelOption = {
  id: string;
  optionLabel: string;
};

async function configurePriceOverride(page: Page): Promise<void> {
  await saveManualPriceOverride(page, {
    inputUsdPerMillionTokens: "0.5",
    modelId: mvpHappyPathNames.initialProviderModelId,
    outputUsdPerMillionTokens: "1.5",
    providerKey: mvpHappyPathNames.providerKey,
  });
  await saveManualPriceOverride(page, {
    inputUsdPerMillionTokens: "0.1",
    modelId: mvpHappyPathNames.reloadedProviderModelId,
    outputUsdPerMillionTokens: "0.4",
    providerKey: mvpHappyPathNames.providerKey,
  });
}

async function saveManualPriceOverride(
  page: Page,
  input: {
    inputUsdPerMillionTokens: string;
    modelId: string;
    outputUsdPerMillionTokens: string;
    providerKey: string;
  },
): Promise<void> {
  await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("providerKey", payload.providerKey);
    body.set("modelId", payload.modelId);
    body.set("inputUsdPerMillionTokens", payload.inputUsdPerMillionTokens);
    body.set("outputUsdPerMillionTokens", payload.outputUsdPerMillionTokens);

    const response = await fetch("/api/prices/override", { body, method: "POST" });
    if (!response.ok) {
      throw new Error(`Manual price override failed with HTTP ${response.status}.`);
    }
  }, input);
}

async function storeProviderApiKey(page: Page): Promise<void> {
  await page.getByLabel("Provider API key").fill(providerApiKey);
  await page.getByRole("button", { name: "Store provider API key" }).click();
  await expect(page.getByRole("heading", { name: "Provider API key saved" })).toBeVisible();
  await expect(page.locator("code")).toHaveText(providerApiKey);
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(
    page.getByText(`Provider API key prefix: ${providerApiKey.slice(0, 8)}`),
  ).toBeVisible();
}

async function createVirtualModelAndRoutePolicy(
  page: Page,
  initialModelOptionLabel: string,
): Promise<void> {
  await page
    .getByRole("textbox", { name: "Virtual model name" })
    .fill(mvpHappyPathNames.virtualModelDisplayName);
  await page
    .getByRole("textbox", { name: "Virtual model display name" })
    .fill(mvpHappyPathNames.virtualModelDisplayName);
  await page.getByRole("button", { name: "Create virtual model" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: mvpHappyPathNames.virtualModelDisplayName }),
  ).toBeVisible();

  await page.getByLabel("Route policy virtual model").selectOption({
    label: `${mvpHappyPathNames.virtualModelDisplayName} (${mvpHappyPathNames.virtualModelName})`,
  });
  await page.getByLabel("Route policy strategy").selectOption("fixed");
  await page.getByLabel("Primary provider models").selectOption({ label: initialModelOptionLabel });
  await page.getByRole("button", { name: "Create route policy" }).click();
  await expect(page.getByText(`Primary: ${initialModelOptionLabel}`)).toBeVisible();
}

async function createAgentApiKeyWithAccessAndLimits(page: Page): Promise<string> {
  await page.getByLabel("Agent name").fill("MVP Codex");
  await page.getByLabel("Agent type").selectOption("coding");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "MVP Codex" })).toBeVisible();

  await page.getByRole("button", { name: "Create Agent API key" }).click();
  await expect(page.getByRole("heading", { name: "Agent API key created" })).toBeVisible();
  const agentApiKey = await page.locator("code").innerText();
  await page.getByRole("link", { name: "Back to dashboard" }).click();

  const virtualModelLabel = `${mvpHappyPathNames.virtualModelDisplayName} (${mvpHappyPathNames.virtualModelName})`;
  await page.getByLabel("Allowed virtual models").selectOption({ label: virtualModelLabel });
  await page.getByLabel("Default virtual model").selectOption({ label: virtualModelLabel });
  await page.getByRole("button", { name: "Save Agent API key virtual models" }).click();
  await expect(page.getByText(`Default Virtual Model: ${virtualModelLabel}`)).toBeVisible();

  await page.getByLabel("Budget USD limit").fill("100");
  await page.getByLabel("Budget period").selectOption("month");
  await page.getByLabel("Budget price provider key").fill(mvpHappyPathNames.providerKey);
  await page.getByLabel("Budget price model id").fill(mvpHappyPathNames.initialProviderModelId);
  await page.getByLabel("RPM limit").fill("120");
  await page.getByLabel("TPM limit").fill("120000");
  await page.getByLabel("Token limit").fill("12000");
  await page.getByRole("button", { name: "Save Agent API key limits" }).click();
  await expect(page.getByText("Budget Limit: $100.00 / month")).toBeVisible();

  return agentApiKey;
}

async function seedProviderAndModels(
  fixture: Fixture,
  providerBaseUrl: string,
): Promise<{ initial: ProviderModelOption; reloaded: ProviderModelOption }> {
  const providerId = randomUUID();
  const initialModelId = randomUUID();
  const reloadedModelId = randomUUID();
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [
      providerId,
      mvpHappyPathNames.providerKey,
      mvpHappyPathNames.providerDisplayName,
      providerBaseUrl,
    ],
  );
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        context_window,
        supports_streaming,
        supports_tools,
        availability
      )
      values ($1, $2, $3, $4, 128000, true, true, 'available'),
             ($5, $2, $6, $7, 128000, true, true, 'available')
    `,
    [
      initialModelId,
      providerId,
      mvpHappyPathNames.initialProviderModelId,
      mvpHappyPathNames.initialProviderModelDisplayName,
      reloadedModelId,
      mvpHappyPathNames.reloadedProviderModelId,
      mvpHappyPathNames.reloadedProviderModelDisplayName,
    ],
  );
  return {
    initial: {
      id: initialModelId,
      optionLabel: buildMvpHappyPathModelOptionLabel({
        modelDisplayName: mvpHappyPathNames.initialProviderModelDisplayName,
        modelId: mvpHappyPathNames.initialProviderModelId,
        providerDisplayName: mvpHappyPathNames.providerDisplayName,
      }),
    },
    reloaded: {
      id: reloadedModelId,
      optionLabel: buildMvpHappyPathModelOptionLabel({
        modelDisplayName: mvpHappyPathNames.reloadedProviderModelDisplayName,
        modelId: mvpHappyPathNames.reloadedProviderModelId,
        providerDisplayName: mvpHappyPathNames.providerDisplayName,
      }),
    },
  };
}

async function expectGatewayChat(
  baseUrl: string,
  input: { agentApiKey: string; model: string; requestId: string },
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 100,
      messages: [{ content: `hello ${input.requestId}`, role: "user" }],
      model: input.model,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    choices: [{ message: { content: "fake provider response" } }],
    object: "chat.completion",
  });
}

function readProviderRequestModels(requests: Array<{ bodyJson: unknown }>): string[] {
  return requests.map((request) => {
    if (isRecord(request.bodyJson) && typeof request.bodyJson.model === "string") {
      return request.bodyJson.model;
    }
    return "unknown";
  });
}

async function readLatestConfigVersion(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ version: number }>(
    "select coalesce(max(version), 0)::integer as version from config_versions",
  );
  return result.rows[0]?.version ?? 0;
}

async function waitForGatewayConfigVersion(baseUrl: string, version: number): Promise<void> {
  await expect
    .poll(async () => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      return isRecord(body) && typeof body.configVersion === "number" ? body.configVersion : 0;
    })
    .toBe(version);
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
        message: `Console did not start.\nstdout=${consoleApp.stdout.join("")}\nstderr=${consoleApp.stderr.join("")}`,
        timeout: 15_000,
      },
    )
    .toBe(200);
}

async function waitForGateway(baseUrl: string, gateway: GatewayProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (gateway.child.exitCode !== null) {
          return `exited:${gateway.child.exitCode}`;
        }

        try {
          const response = await fetch(`${baseUrl}/health`);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      {
        message: `Gateway did not start.\nstdout=${gateway.stdout.join("")}\nstderr=${gateway.stderr.join("")}`,
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
        MASTER_KEY: masterKey,
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

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "250",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gateway: GatewayProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => gateway.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => gateway.stdout.push(String(chunk)));
  return gateway;
}

async function stopConsoleProcess(consoleApp: ConsoleProcess): Promise<void> {
  if (consoleApp.child.exitCode !== null) {
    return;
  }

  consoleApp.child.kill("SIGTERM");
  await waitForExitOrKill(consoleApp.child);
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  gateway.child.kill("SIGTERM");
  await waitForExitOrKill(gateway.child);
}

async function waitForExitOrKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
