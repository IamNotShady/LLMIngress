import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

test("advanced route rules select candidates and dry run preview explains the decision", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_route_preview_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedAdvancedRoutePreview(fixture, `${provider.url}/v1`);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await seedAuthenticatedConsoleSession(fixture, context, baseUrl);
          const page = await context.newPage();
          await page.goto(baseUrl);

          const result = await postRoutePreview(page, {
            estimatedInputTokens: 1000,
            estimatedOutputTokens: 1000,
            taskType: "coding",
            usesTools: true,
            virtualModelName: seeded.virtualModelName,
          });

          expect(result.status).toBe(200);
          expect(result.body).toMatchObject({
            decision: {
              modelId: "advanced-coder",
              providerModelId: seeded.advancedProviderModelId,
              routeReason: {
                appliedRules: {
                  requireTools: true,
                  requiredCapabilities: ["reasoning", "tools"],
                  retryAttempts: 1,
                  taskTypes: ["coding"],
                  timeoutMs: 2000,
                },
                selectedCandidateOrder: 2,
                strategy: "cost_first",
              },
            },
            input: {
              estimatedInputTokens: 1000,
              estimatedOutputTokens: 1000,
              taskType: "coding",
              usesTools: true,
              virtualModelName: seeded.virtualModelName,
            },
          });
          expect(result.body.candidates).toEqual([
            {
              candidateOrder: 1,
              eligible: false,
              providerModelId: seeded.cheapProviderModelId,
              reasons: [
                "request uses tools but model does not support tools",
                "missing required capabilities: reasoning, tools",
                "policy timeout 2000ms exceeds model max timeout 1000ms",
                "policy retry attempts require retryable model",
              ],
            },
            {
              candidateOrder: 2,
              eligible: true,
              providerModelId: seeded.advancedProviderModelId,
              reasons: ["selected by cost_first strategy"],
            },
          ]);
          expect(provider.requests).toHaveLength(0);
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

type PreviewPostResult = {
  body: Record<string, unknown>;
  status: number;
};

async function seedAdvancedRoutePreview(
  fixture: Fixture,
  providerBaseUrl: string,
): Promise<{
  advancedProviderModelId: string;
  cheapProviderModelId: string;
  virtualModelName: string;
}> {
  const providerId = randomUUID();
  const cheapProviderModelId = randomUUID();
  const advancedProviderModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const virtualModelName = "advanced-coding-preview";

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', $2, true)
    `,
    [providerId, providerBaseUrl],
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
        availability,
        capability_metadata
      )
      values ($1, $2, 'cheap-coder', 'Cheap Coder', 4096, true, false, 'available', $3::jsonb),
             ($4, $2, 'advanced-coder', 'Advanced Coder', 8192, true, true, 'available', $5::jsonb)
    `,
    [
      cheapProviderModelId,
      providerId,
      JSON.stringify({
        coding: true,
        maxTimeoutMs: 1000,
        reasoning: false,
        retryable: false,
        tools: false,
      }),
      advancedProviderModelId,
      JSON.stringify({
        coding: true,
        maxTimeoutMs: 5000,
        reasoning: true,
        retryable: true,
        tools: true,
      }),
    ],
  );
  await fixture.query(
    `
      insert into provider_models_price (
        id,
        provider_key,
        model_id,
        input_usd_per_million_tokens,
        output_usd_per_million_tokens,
        source,
        source_url,
        price_version,
        synced_at
      )
      values ($1, 'openai', 'cheap-coder', 0.10, 0.20, 'models.dev', 'https://models.dev/api.json', 'models.dev:106', now()),
             ($2, 'openai', 'advanced-coder', 3.00, 9.00, 'models.dev', 'https://models.dev/api.json', 'models.dev:106', now())
    `,
    [randomUUID(), randomUUID()],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, $2, 'Advanced Coding Preview', true)
    `,
    [virtualModelId, virtualModelName],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy, rules)
      values ($1, $2, 'cost_first', $3::jsonb)
    `,
    [
      routePolicyId,
      virtualModelId,
      JSON.stringify({
        requireTools: true,
        requiredCapabilities: ["reasoning", "tools"],
        retryAttempts: 1,
        taskTypes: ["coding"],
        timeoutMs: 2000,
      }),
    ],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order,
        is_fallback
      )
      values ($1, $2, $3, 1, false),
             ($4, $2, $5, 2, false)
    `,
    [randomUUID(), routePolicyId, cheapProviderModelId, randomUUID(), advancedProviderModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Advanced route preview config')",
  );

  return {
    advancedProviderModelId,
    cheapProviderModelId,
    virtualModelName,
  };
}

async function postRoutePreview(
  page: Page,
  input: {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    taskType: string;
    usesTools: boolean;
    virtualModelName: string;
  },
): Promise<PreviewPostResult> {
  return page.evaluate(async (payload) => {
    const response = await fetch("/api/route-policies/preview", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return {
      body: await response.json(),
      status: response.status,
    };
  }, input);
}

async function seedAuthenticatedConsoleSession(
  fixture: Fixture,
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  const sessionToken = `route-preview-session-${randomUUID()}`;
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
