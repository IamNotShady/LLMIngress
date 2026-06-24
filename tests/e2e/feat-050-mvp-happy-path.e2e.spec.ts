import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { openDisclosure, openRow } from "../support/console-ui";
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
        const consoleBaseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(consoleBaseUrl, consoleApp);
          await signInFromFirstRun(page, consoleBaseUrl);

          const modelOptions = await seedProviderAndModels(fixture, `${provider.url}/v1`);
          await configurePriceOverride(page);
          await page.goto(`${consoleBaseUrl}/providers`);
          await expect(
            page.getByRole("article").getByRole("heading", {
              exact: true,
              name: mvpHappyPathNames.providerDisplayName,
            }),
          ).toBeVisible();
          await storeProviderApiKey(page);
          await page.goto(`${consoleBaseUrl}/models`);
          await createVirtualModelAndRoutePolicy(page, {
            id: modelOptions.initial.id,
          });
          await page.goto(`${consoleBaseUrl}/agents`);
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

            await page.goto(`${consoleBaseUrl}/activity`);
            const activitySection = page.getByLabel("Activity");
            await expect(
              activitySection.getByRole("link", {
                name: buildMvpHappyPathRequestId("initial"),
              }),
            ).toBeVisible();
            await page.goto(`${consoleBaseUrl}/usage`);
            await expect(
              page
                .getByLabel("Usage")
                .locator(".stat-card", { hasText: "Total requests" })
                .locator(".stat-card-value"),
            ).toHaveText("1");
            await expect(
              page.getByLabel("Usage").getByRole("cell", {
                name: mvpHappyPathNames.initialProviderModelDisplayName,
                exact: true,
              }),
            ).toBeVisible();

            const virtualModelId = await readVirtualModelId(fixture);
            const routePolicyId = await readRoutePolicyId(fixture);
            await postRoutePolicyAction(page, {
              action: "update",
              id: routePolicyId,
              primaryProviderModelIds: [modelOptions.reloaded.id],
              strategy: "fixed",
              virtualModelId,
            });
            await expect
              .poll(() => readPrimaryProviderModelId(fixture))
              .toBe(modelOptions.reloaded.id);
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

            await page.goto(`${consoleBaseUrl}/activity`);
            await expect(
              page
                .getByLabel("Activity")
                .getByRole("link", { name: buildMvpHappyPathRequestId("reloaded") }),
            ).toBeVisible();
            await page.goto(`${consoleBaseUrl}/usage`);
            await expect(
              page
                .getByLabel("Usage")
                .locator(".stat-card", { hasText: "Total requests" })
                .locator(".stat-card-value"),
            ).toHaveText("2");
            await expect(
              page.getByLabel("Usage").getByRole("cell", {
                name: mvpHappyPathNames.reloadedProviderModelDisplayName,
                exact: true,
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
  selectorLabel: string;
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
  await openRow(page, mvpHappyPathNames.providerDisplayName);
  await page.getByRole("link", { name: "Add API key" }).click();
  await page
    .getByRole("dialog", { name: /API key/ })
    .getByRole("textbox", { name: "Provider API key" })
    .fill(providerApiKey);
  await page.getByRole("button", { name: "Save API key" }).click();
  await expect(page.getByRole("heading", { name: "Provider API key saved" })).toBeVisible();
  await expect(page.locator("code")).toHaveText(providerApiKey);
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await openRow(page, mvpHappyPathNames.providerDisplayName);
  await expect(page.getByRole("row", { name: /- 100 Unknown/ })).toBeVisible();
}

async function createVirtualModelAndRoutePolicy(
  page: Page,
  initialModelOption: { id: string },
): Promise<void> {
  await postVirtualModelWithRoute(page, {
    description: mvpHappyPathNames.virtualModelDisplayName,
    name: mvpHappyPathNames.virtualModelName,
    primaryProviderModelIds: [initialModelOption.id],
    strategy: "fixed",
  });
}

async function createAgentApiKeyWithAccessAndLimits(page: Page): Promise<string> {
  await openDisclosure(page, "New agent");
  await page.getByLabel("Agent name").fill("MVP Codex");
  await page.getByLabel("Agent type").selectOption("coding");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: "Agent created" })).toBeVisible();
  const agentApiKey = await page.locator("code").innerText();
  await page.getByRole("link", { name: "Back to dashboard" }).click();

  const virtualModelLabel = `${mvpHappyPathNames.virtualModelDisplayName} (${mvpHappyPathNames.virtualModelName})`;
  await openRow(page, "MVP Codex");
  await page.getByLabel("Allowed virtual models").selectOption({ label: virtualModelLabel });
  await page.getByLabel("Default virtual model").selectOption({ label: virtualModelLabel });
  await page.getByRole("button", { name: "Save" }).click();
  await openRow(page, "MVP Codex");
  await expect(page.getByLabel("Default virtual model").locator("option:checked")).toHaveText(
    virtualModelLabel,
  );

  await page.getByLabel("Budget USD limit").fill("100");
  await page.getByLabel("Budget period").selectOption("month");
  await page.getByLabel("RPM limit").fill("120");
  await page.getByLabel("TPM limit").fill("120000");
  await page.getByLabel("Token limit").fill("12000");
  await page.getByRole("button", { name: "Save" }).click();
  await openRow(page, "MVP Codex");
  await expect(page.getByLabel("Budget USD limit")).toHaveValue("100");

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
      selectorLabel: `${buildMvpHappyPathModelOptionLabel({
        modelDisplayName: mvpHappyPathNames.initialProviderModelDisplayName,
        modelId: mvpHappyPathNames.initialProviderModelId,
        providerDisplayName: mvpHappyPathNames.providerDisplayName,
      })} - Priced (manual override)`,
    },
    reloaded: {
      id: reloadedModelId,
      optionLabel: buildMvpHappyPathModelOptionLabel({
        modelDisplayName: mvpHappyPathNames.reloadedProviderModelDisplayName,
        modelId: mvpHappyPathNames.reloadedProviderModelId,
        providerDisplayName: mvpHappyPathNames.providerDisplayName,
      }),
      selectorLabel: `${buildMvpHappyPathModelOptionLabel({
        modelDisplayName: mvpHappyPathNames.reloadedProviderModelDisplayName,
        modelId: mvpHappyPathNames.reloadedProviderModelId,
        providerDisplayName: mvpHappyPathNames.providerDisplayName,
      })} - Priced (manual override)`,
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

async function readVirtualModelId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text from virtual_models where name = $1",
    [mvpHappyPathNames.virtualModelName],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("MVP virtual model was not found.");
  }
  return id;
}

async function readRoutePolicyId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>("select id::text from route_policies");
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("MVP route policy was not found.");
  }
  return id;
}

async function readPrimaryProviderModelId(fixture: Fixture): Promise<string | null> {
  const result = await fixture.query<{ provider_model_id: string }>(
    `
      select provider_model_id::text
      from route_policy_candidates
      order by candidate_order
      limit 1
    `,
  );
  return result.rows[0]?.provider_model_id ?? null;
}

async function postVirtualModelWithRoute(
  page: Page,
  input: {
    description: string;
    name: string;
    primaryProviderModelIds: string[];
    strategy: string;
  },
): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", "createWithRoute");
    body.set("name", payload.name);
    body.set("description", payload.description);
    body.set("strategy", payload.strategy);
    for (const providerModelId of payload.primaryProviderModelIds) {
      body.append("primaryProviderModelIds", providerModelId);
    }
    const response = await fetch("/api/virtual-models", { body, method: "POST" });
    return { status: response.status, text: await response.text() };
  }, input);
  expect(result.status, result.text).toBe(200);
}

async function postRoutePolicyAction(
  page: Page,
  input: {
    action: string;
    id: string;
    primaryProviderModelIds: string[];
    strategy: string;
    virtualModelId: string;
  },
): Promise<void> {
  const result = await page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", payload.action);
    body.set("id", payload.id);
    body.set("virtualModelId", payload.virtualModelId);
    body.set("strategy", payload.strategy);
    for (const providerModelId of payload.primaryProviderModelIds) {
      body.append("primaryProviderModelIds", providerModelId);
    }
    const response = await fetch("/api/route-policies", { body, method: "POST" });
    return { status: response.status, text: await response.text() };
  }, input);
  expect(result.status, result.text).toBe(200);
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
  let lastObservedStatus = "not-started";

  await expect
    .poll(
      async () => {
        if (consoleApp.child.exitCode !== null) {
          return formatConsoleStartupFailure(consoleApp, lastObservedStatus);
        }

        try {
          const response = await fetch(baseUrl);
          if (response.status !== 200) {
            lastObservedStatus = `status:${response.status}:${(await response.text()).slice(0, 500)}`;
            return lastObservedStatus;
          }
          lastObservedStatus = String(response.status);
          return response.status;
        } catch (error) {
          lastObservedStatus = `fetch-error:${
            error instanceof Error ? error.message : String(error)
          }`;
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

function formatConsoleStartupFailure(
  consoleApp: ConsoleProcess,
  lastObservedStatus: string,
): string {
  return [
    `exited:${consoleApp.child.exitCode}`,
    `last:${lastObservedStatus}`,
    `stdout:${consoleApp.stdout.join("")}`,
    `stderr:${consoleApp.stderr.join("")}`,
  ].join("\n");
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
