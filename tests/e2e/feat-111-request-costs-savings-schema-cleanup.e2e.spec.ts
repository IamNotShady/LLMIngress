import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, loadSqlMigrations, runMigrations } from "../../packages/db/src";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-savings-111";
const agentApiKey = "llmi_request_costs_savings_key_111";

test("request savings live on request_costs and migration_history replaces schema_version", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_costs_savings_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedSavingsRoute(fixture, {
      providerBaseUrl: `${provider.url}/v1`,
    });

    await expect(readRegclass(fixture, "request_savings")).resolves.toBe(null);
    await expect(readRegclass(fixture, "schema_version")).resolves.toBe(null);

    const status = spawnSync(
      "pnpm",
      ["run", "db:migrate:status", "--", "--database-url", fixture.databaseUrl],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      },
    );
    const latestMigrationId = loadSqlMigrations().at(-1)?.id;
    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(status.stdout).toContain(`Current schema: ${latestMigrationId}`);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          max_tokens: 100,
          messages: [{ content: "hello from feat 111", role: "user" }],
          model: "request-costs-savings",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_request_costs_savings_111",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "fake-provider-response",
        object: "chat.completion",
      });

      await expect
        .poll(() => readRequestCostsSavingsRow(fixture))
        .toEqual({
          actual_cost_usd: "0.00004050",
          baseline_cost_usd: "0.00081000",
          baseline_provider_model_id: seeded.baselineProviderModelId,
          cost_source: "estimated",
          input_cost_usd: "0.00000050",
          output_cost_usd: "0.00004000",
          price_source: "price_sync",
          provider_model_id: seeded.actualProviderModelId,
          request_id: "req_request_costs_savings_111",
          savings_percent: "95.000000",
          savings_price_source: "price_sync",
          savings_price_version: "test:feat-111",
          savings_usd: "0.00076950",
          total_cost_usd: "0.00004050",
        });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type SeededSavingsRoute = {
  actualProviderModelId: string;
  baselineProviderModelId: string;
};

type RequestCostsSavingsRow = {
  actual_cost_usd: string;
  baseline_cost_usd: string;
  baseline_provider_model_id: string;
  cost_source: string;
  input_cost_usd: string;
  output_cost_usd: string;
  price_source: string | null;
  provider_model_id: string;
  request_id: string;
  savings_percent: string;
  savings_price_source: string | null;
  savings_price_version: string | null;
  savings_usd: string;
  total_cost_usd: string;
};

async function seedSavingsRoute(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<SeededSavingsRoute> {
  const providerId = randomUUID();
  const baselineProviderModelId = randomUUID();
  const actualProviderModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [
      randomUUID(),
      providerId,
      providerApiKey.slice(0, 8),
      JSON.stringify(encrypted),
      encrypted.keyId,
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
      values ($1, $2, 'gpt-4.1', 'GPT 4.1', 128000, true, true, 'available'),
             ($3, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 128000, true, true, 'available')
    `,
    [baselineProviderModelId, providerId, actualProviderModelId],
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = prices.input_price,
          synced_cached_input_usd_per_million_tokens = prices.cached_input_price,
          synced_output_usd_per_million_tokens = prices.output_price,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'test://prices/feat-111',
          synced_price_version = 'test:feat-111',
          synced_price_synced_at = '2026-06-20T00:00:00.000Z',
          synced_price_updated_at = '2026-06-20T00:00:00.000Z'
      from (
        values
          ('gpt-4.1', 2::numeric, null::numeric, 8::numeric),
          ('gpt-4.1-nano', 0.1::numeric, null::numeric, 0.4::numeric)
      ) as prices(model_id, input_price, cached_input_price, output_price)
      where provider_models.model_id = prices.model_id
    `,
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'request-costs-savings', 'Request Costs Savings', true)",
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order
      )
      values ($1, $2, $3, 1),
             ($4, $2, $5, 2)
    `,
    [randomUUID(), routePolicyId, baselineProviderModelId, randomUUID(), actualProviderModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Savings Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents
      set id = $1,
          key_prefix = $3,
          key_hash = $4,
          default_virtual_model_id = $5,
          enabled = true,
          updated_at = now()
      where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(agentApiKey),
      virtualModelId,
    ],
  );
  await fixture.query(
    "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Request costs savings config')",
  );

  return { actualProviderModelId, baselineProviderModelId };
}

async function readRegclass(fixture: Fixture, tableName: string): Promise<string | null> {
  const result = await fixture.query<{ table_name: string | null }>(
    "select to_regclass($1)::text as table_name",
    [`public.${tableName}`],
  );
  return result.rows[0]?.table_name ?? null;
}

async function readRequestCostsSavingsRow(
  fixture: Fixture,
): Promise<RequestCostsSavingsRow | null> {
  const result = await fixture.query<RequestCostsSavingsRow>(
    `
      select request_activity.request_id,
             request_costs.provider_model_id::text,
             request_costs.input_cost_usd::text,
             request_costs.output_cost_usd::text,
             request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.price_source,
             request_costs.baseline_provider_model_id::text,
             request_costs.actual_cost_usd::text,
             request_costs.baseline_cost_usd::text,
             request_costs.savings_usd::text,
             request_costs.savings_percent::text,
             request_costs.savings_price_source,
             request_costs.savings_price_version
      from request_activity
      join request_costs on request_costs.request_activity_id = request_activity.id
      where request_activity.request_id = 'req_request_costs_savings_111'
    `,
  );
  return result.rows[0] ?? null;
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

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "0",
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

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  gateway.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    gateway.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
