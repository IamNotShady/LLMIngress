import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { withProcessLock } from "../support/process-lock";

test("route policy editor supports strategy filters fallback warnings validation and excludes v2 task context tool rules", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_route_editor_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRouteEditorData(fixture);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://127.0.0.1:${consoleApp.port}`;
        const context = await browser.newContext();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await seedAuthenticatedConsoleSession(fixture, context, baseUrl);
          const page = await context.newPage();

          await page.goto(
            `${baseUrl}/?routeProviderFilter=openai&routeModelFilter=gpt#route-policies`,
          );
          const routePolicySection = routePoliciesSection(page);

          await expect(routePolicySection.getByLabel("Route provider filter")).toHaveValue(
            "openai",
          );
          await expect(routePolicySection.getByLabel("Route model filter")).toHaveValue("gpt");
          await expect(routePolicySection.getByLabel("Primary provider models")).toContainText(
            seeded.openaiGpt.selectorLabel,
          );
          await expect(routePolicySection.getByLabel("Primary provider models")).not.toContainText(
            seeded.anthropicClaude.selectorLabel,
          );
          await expect(routePolicySection.getByLabel("Primary provider models")).not.toContainText(
            seeded.fireworksMixtral.selectorLabel,
          );
          await expect(routePolicySection.getByLabel(/task/i)).toHaveCount(0);
          await expect(routePolicySection.getByLabel(/context/i)).toHaveCount(0);
          await expect(routePolicySection.getByLabel(/tool/i)).toHaveCount(0);

          await expect(
            postRoutePolicy(page, {
              fallbackProviderModelIds: [seeded.openaiGpt.id],
              primaryProviderModelIds: [seeded.openaiGpt.id],
              strategy: "fixed",
              virtualModelId: seeded.virtualModelId,
            }),
          ).resolves.toEqual({
            body: { error: expect.stringMatching(/duplicate provider models/i) },
            status: 400,
          });
          await expect.poll(() => countRoutePolicies(fixture)).toBe(0);

          await page.goto(`${baseUrl}/#route-policies`);
          await routePolicySection
            .getByLabel("Route policy virtual model")
            .selectOption({ label: "Route Editor VM (route-editor-vm)" });
          await routePolicySection.getByLabel("Route policy strategy").selectOption("cost_first");
          await routePolicySection
            .getByLabel("Primary provider models")
            .selectOption({ label: seeded.openaiGpt.selectorLabel });
          await routePolicySection
            .getByLabel("Fallback provider models")
            .selectOption([
              { label: seeded.anthropicClaude.selectorLabel },
              { label: seeded.fireworksMixtral.selectorLabel },
            ]);
          const createResult = await postRoutePolicy(page, {
            fallbackProviderModelIds: [seeded.anthropicClaude.id, seeded.fireworksMixtral.id],
            primaryProviderModelIds: [seeded.openaiGpt.id],
            strategy: "cost_first",
            virtualModelId: seeded.virtualModelId,
          });
          expect(createResult.body).toBeNull();
          expect([0, 303]).toContain(createResult.status);
          await expect.poll(() => countRoutePolicies(fixture)).toBe(1);
          await page.goto(`${baseUrl}/?routeEditorReload=created#route-policies`);

          await expect(routePolicySection.getByText("Strategy: cost_first")).toBeVisible();
          await expect(
            routePolicySection.getByText(
              `Fallback order: 1. ${seeded.anthropicClaude.optionLabel} -> 2. ${seeded.fireworksMixtral.optionLabel}`,
            ),
          ).toBeVisible();
          await expect(
            routePolicySection.getByText(
              `Price warning: ${seeded.anthropicClaude.optionLabel} has unknown price; save a manual price override before using budgeted routes.`,
            ),
          ).toBeVisible();
          await expect(
            routePolicySection.getByText(
              `Route warning: ${seeded.fireworksMixtral.optionLabel} is unavailable and excluded from Gateway routing.`,
            ),
          ).toBeVisible();
          await expect(
            routePolicySection.getByText(
              `Health warning: ${seeded.anthropicClaude.optionLabel} provider health is Degraded.`,
            ),
          ).toBeVisible();
          await expect(
            routePolicySection.getByText(
              `Health warning: ${seeded.anthropicClaude.optionLabel} model health is Unhealthy.`,
            ),
          ).toBeVisible();

          await routePolicySection
            .getByLabel("Edit route policy strategy")
            .selectOption("quality_first");
          await routePolicySection
            .getByLabel("Edit primary provider models")
            .selectOption({ label: seeded.anthropicClaude.selectorLabel });
          await routePolicySection
            .getByLabel("Edit fallback provider models")
            .selectOption([
              { label: seeded.openaiGpt.selectorLabel },
              { label: seeded.fireworksMixtral.selectorLabel },
            ]);
          await postRoutePolicyUpdate(page, {
            fallbackProviderModelIds: [seeded.openaiGpt.id, seeded.fireworksMixtral.id],
            id: await readOnlyRoutePolicyId(fixture),
            primaryProviderModelIds: [seeded.anthropicClaude.id],
            strategy: "quality_first",
            virtualModelId: seeded.virtualModelId,
          });
          await page.goto(`${baseUrl}/?routeEditorReload=updated#route-policies`);

          await expect(routePolicySection.getByText("Strategy: quality_first")).toBeVisible();
          await expect
            .poll(() => readRoutePolicyState(fixture))
            .toEqual({
              candidates: [
                {
                  candidateOrder: 1,
                  isFallback: false,
                  providerModelId: seeded.anthropicClaude.id,
                },
                {
                  candidateOrder: 2,
                  isFallback: true,
                  providerModelId: seeded.openaiGpt.id,
                },
                {
                  candidateOrder: 3,
                  isFallback: true,
                  providerModelId: seeded.fireworksMixtral.id,
                },
              ],
              strategy: "quality_first",
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

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type SeededModel = {
  id: string;
  optionLabel: string;
  selectorLabel: string;
};

type RoutePolicyState = {
  candidates: Array<{
    candidateOrder: number;
    isFallback: boolean;
    providerModelId: string;
  }>;
  strategy: string;
};

async function seedRouteEditorData(fixture: Fixture): Promise<{
  anthropicClaude: SeededModel;
  fireworksMixtral: SeededModel;
  openaiGpt: SeededModel;
  virtualModelId: string;
}> {
  const virtualModelId = randomUUID();
  const openaiProviderId = randomUUID();
  const anthropicProviderId = randomUUID();
  const fireworksProviderId = randomUUID();
  const openaiGptId = randomUUID();
  const anthropicClaudeId = randomUUID();
  const fireworksMixtralId = randomUUID();

  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'route-editor-vm', 'Route Editor VM', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', 'https://api.openai.com/v1', true),
             ($2, 'api_key', 'anthropic', 'Anthropic', 'https://api.anthropic.com/v1', true),
             ($3, 'api_key', 'fireworks', 'Fireworks', 'https://api.fireworks.ai/inference/v1', true)
    `,
    [openaiProviderId, anthropicProviderId, fireworksProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 'available'),
             ($3, $4, 'claude-sonnet-4', 'Claude Sonnet 4', 'available'),
             ($5, $6, 'mixtral-8x7b', 'Mixtral 8x7B', 'unavailable')
    `,
    [
      openaiGptId,
      openaiProviderId,
      anthropicClaudeId,
      anthropicProviderId,
      fireworksMixtralId,
      fireworksProviderId,
    ],
  );
  await seedProviderHealth(fixture, {
    providerId: anthropicProviderId,
    providerModelId: anthropicClaudeId,
  });

  return {
    anthropicClaude: {
      id: anthropicClaudeId,
      optionLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4)",
      selectorLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4) - Unknown price",
    },
    fireworksMixtral: {
      id: fireworksMixtralId,
      optionLabel: "Fireworks - Mixtral 8x7B (mixtral-8x7b)",
      selectorLabel: "Fireworks - Mixtral 8x7B (mixtral-8x7b) - Unknown price",
    },
    openaiGpt: {
      id: openaiGptId,
      optionLabel: "OpenAI - GPT 4.1 Mini (gpt-4.1-mini)",
      selectorLabel: "OpenAI - GPT 4.1 Mini (gpt-4.1-mini) - Priced (built-in)",
    },
    virtualModelId,
  };
}

async function seedProviderHealth(
  fixture: Fixture,
  input: { providerId: string; providerModelId: string },
): Promise<void> {
  const providerEventId = randomUUID();
  const modelEventId = randomUUID();
  await fixture.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        trigger,
        status,
        observed_at
      )
      values ($1, $2, null, 'manual', 'degraded', '2026-06-16T05:30:00.000Z'),
             ($3, $2, $4, 'request_path', 'failed', '2026-06-16T05:31:00.000Z')
    `,
    [providerEventId, input.providerId, modelEventId, input.providerModelId],
  );
  await fixture.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        last_event_id,
        status,
        consecutive_failures,
        last_failure_at,
        updated_at
      )
      values ($1, $2, null, $3, 'degraded', 1, '2026-06-16T05:30:00.000Z', '2026-06-16T05:30:00.000Z'),
             ($4, $2, $5, $6, 'unhealthy', 3, '2026-06-16T05:31:00.000Z', '2026-06-16T05:31:00.000Z')
    `,
    [
      randomUUID(),
      input.providerId,
      providerEventId,
      randomUUID(),
      input.providerModelId,
      modelEventId,
    ],
  );
}

function routePoliciesSection(page: Page): Locator {
  return page
    .getByRole("heading", { name: "Route policies" })
    .locator("xpath=ancestor::section[1]");
}

async function postRoutePolicy(
  page: Page,
  input: {
    fallbackProviderModelIds: string[];
    primaryProviderModelIds: string[];
    strategy: string;
    virtualModelId: string;
  },
) {
  return submitRoutePolicyForm(page, { action: "create", ...input });
}

async function postRoutePolicyUpdate(
  page: Page,
  input: {
    fallbackProviderModelIds: string[];
    id: string;
    primaryProviderModelIds: string[];
    strategy: string;
    virtualModelId: string;
  },
) {
  const result = await submitRoutePolicyForm(page, { action: "update", ...input });
  expect(result.body).toBeNull();
  expect([0, 303]).toContain(result.status);
}

async function submitRoutePolicyForm(
  page: Page,
  input: {
    action: "create" | "update";
    fallbackProviderModelIds: string[];
    id?: string;
    primaryProviderModelIds: string[];
    strategy: string;
    virtualModelId: string;
  },
) {
  return page.evaluate(async (payload) => {
    const body = new FormData();
    body.set("action", payload.action);
    if (payload.id) {
      body.set("id", payload.id);
    }
    body.set("virtualModelId", payload.virtualModelId);
    body.set("strategy", payload.strategy);
    for (const providerModelId of payload.primaryProviderModelIds) {
      body.append("primaryProviderModelIds", providerModelId);
    }
    for (const providerModelId of payload.fallbackProviderModelIds) {
      body.append("fallbackProviderModelIds", providerModelId);
    }

    const response = await fetch("/api/route-policies", {
      body,
      method: "POST",
      redirect: "manual",
    });
    const text = response.headers.get("content-type")?.includes("application/json")
      ? await response.text()
      : "";
    return {
      body: text ? JSON.parse(text) : null,
      status: response.status,
    };
  }, input);
}

async function readOnlyRoutePolicyId(fixture: Fixture): Promise<string> {
  const result = await fixture.query<{ id: string }>("select id::text from route_policies");
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Expected exactly one Route Policy.");
  }
  return row.id;
}

async function countRoutePolicies(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from route_policies",
  );
  return result.rows[0]?.count ?? 0;
}

async function readRoutePolicyState(fixture: Fixture): Promise<RoutePolicyState> {
  const policy = await fixture.query<{ strategy: string }>("select strategy from route_policies");
  const candidates = await fixture.query<{
    candidate_order: number;
    is_fallback: boolean;
    provider_model_id: string;
  }>(
    `
      select provider_model_id::text,
             candidate_order,
             is_fallback
      from route_policy_candidates
      order by candidate_order
    `,
  );
  const policyRow = policy.rows[0];
  if (!policyRow) {
    throw new Error("Route policy was not found.");
  }

  return {
    candidates: candidates.rows.map((row) => ({
      candidateOrder: row.candidate_order,
      isFallback: row.is_fallback,
      providerModelId: row.provider_model_id,
    })),
    strategy: policyRow.strategy,
  };
}

async function seedAuthenticatedConsoleSession(
  fixture: Fixture,
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  const sessionToken = `route-editor-session-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await fixture.query(
    "insert into console_admins (id, password_hash) values (1, 'test-admin-hash') on conflict (id) do nothing",
  );
  await fixture.query(
    `
      insert into console_sessions (id, token_hash, expires_at)
      values ($1, $2, $3)
    `,
    [randomUUID(), createHash("sha256").update(sessionToken).digest("base64url"), expiresAt],
  );
  await context.addCookies([
    {
      expires: Math.floor(expiresAt.getTime() / 1000),
      httpOnly: true,
      name: "llmingress_console_session",
      sameSite: "Lax",
      secure: false,
      url: baseUrl,
      value: sessionToken,
    },
  ]);
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
