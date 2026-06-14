import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { selectRouteCandidate } from "../../apps/gateway/src/route-engine";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createModelRefreshJobHandler } from "../../apps/worker/src/model-refresh";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import { withProcessLock } from "../support/process-lock";

test("missing referenced model marked unavailable excluded from routing and warning visible", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_model_soft_delete_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({
    models: [{ id: "old-referenced" }, { id: "stable" }],
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: providerId,
      providerKey: "openai",
    });
    await runModelRefreshJob(fixture, providerId);

    const oldReferencedModelId = await readProviderModelId(fixture, providerId, "old-referenced");
    const stableModelId = await readProviderModelId(fixture, providerId, "stable");
    await insertRoutePolicy(fixture, {
      oldReferencedModelId,
      stableModelId,
    });

    server.setModels([{ id: "stable" }]);
    await runModelRefreshJob(fixture, providerId);

    await expectModelRows(fixture, [
      { availability: "unavailable", model_id: "old-referenced" },
      { availability: "available", model_id: "stable" },
    ]);

    const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
    const routePolicy = snapshot.routePolicies.find(
      (candidate) => candidate.virtualModelName === "soft-delete-coding",
    );
    expect(routePolicy?.candidates.map((candidate) => candidate.modelId)).toEqual(["stable"]);
    expect(
      selectRouteCandidate({
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 1_000,
        snapshot,
        virtualModelName: "soft-delete-coding",
      }).modelId,
    ).toBe("stable");

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

          await expect(
            page.getByText(
              "Route warning: OpenAI - old-referenced (old-referenced) is unavailable and excluded from Gateway routing.",
            ),
          ).toBeVisible();
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await server.close();
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

type ModelRow = {
  availability: string;
  model_id: string;
};

type ProviderInput = {
  baseUrl: string;
  id: string;
  providerKey: string;
};

async function insertProvider(fixture: Fixture, input: ProviderInput): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, 'OpenAI', $3, true)
    `,
    [input.id, input.providerKey, input.baseUrl],
  );
}

async function insertRoutePolicy(
  fixture: Fixture,
  input: { oldReferencedModelId: string; stableModelId: string },
): Promise<void> {
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'soft-delete-coding', 'Soft Delete Coding', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
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
    [randomUUID(), routePolicyId, input.oldReferencedModelId, randomUUID(), input.stableModelId],
  );
}

async function runModelRefreshJob(fixture: Fixture, providerId: string): Promise<void> {
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      model_refresh: createModelRefreshJobHandler({ databaseUrl: fixture.databaseUrl }),
    },
    workerId: `worker-model-soft-delete-${randomUUID()}`,
  });
  const jobId = randomUUID();

  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'model_refresh', 'pending', 'manual', $2, 1)
    `,
    [jobId, JSON.stringify({ providerId })],
  );

  await runner.runOnce();

  const result = await fixture.query<{ error_message: string | null; status: string }>(
    "select status, error_message from jobs where id = $1",
    [jobId],
  );
  expect(result.rows[0]).toEqual({
    error_message: null,
    status: "succeeded",
  });
}

async function readProviderModelId(
  fixture: Fixture,
  providerId: string,
  modelId: string,
): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text as id from provider_models where provider_id = $1 and model_id = $2",
    [providerId, modelId],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`Provider model ${modelId} was not found.`);
  }
  return id;
}

async function expectModelRows(fixture: Fixture, expectedRows: ModelRow[]): Promise<void> {
  const result = await fixture.query<ModelRow>(
    `
      select model_id, availability
      from provider_models
      order by model_id
    `,
  );
  expect(result.rows).toEqual(expectedRows);
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
