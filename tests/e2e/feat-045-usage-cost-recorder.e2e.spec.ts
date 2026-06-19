import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-usage-045";

test("usage record includes tokens actual cost baseline cost savings and unknown price marker", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_usage_cost_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_usage_gateway_key_045";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedUsageRoutes(fixture, {
      agentApiKey,
      providerBaseUrl: `${provider.url}/v1`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayChat(baseUrl, {
        apiKey: agentApiKey,
        model: "usage-cost-known",
        requestId: "req_usage_known_045",
      });
      await expectGatewayChat(baseUrl, {
        apiKey: agentApiKey,
        model: "usage-cost-unknown",
        requestId: "req_usage_unknown_045",
      });

      await expect
        .poll(() => readUsageCostRows(fixture))
        .toEqual([
          {
            baseline_cost_usd: "0.00081000",
            baseline_provider_model_id: seeded.expensiveProviderModelId,
            cost_source: "estimated",
            input_cost_usd: "0.00000050",
            input_tokens: 5,
            output_cost_usd: "0.00004000",
            output_tokens: 100,
            price_source: "price_sync",
            provider_model_id: seeded.cheapProviderModelId,
            request_id: "req_usage_known_045",
            savings_usd: "0.00076950",
            token_source: "estimated",
            total_cost_usd: "0.00004050",
            total_tokens: 105,
          },
          {
            baseline_cost_usd: null,
            baseline_provider_model_id: seeded.unknownProviderModelId,
            cost_source: "unavailable",
            input_cost_usd: null,
            input_tokens: 5,
            output_cost_usd: null,
            output_tokens: 100,
            price_source: "unavailable",
            provider_model_id: seeded.unknownProviderModelId,
            request_id: "req_usage_unknown_045",
            savings_usd: null,
            token_source: "estimated",
            total_cost_usd: null,
            total_tokens: 105,
          },
        ]);
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

type SeededUsageRoutes = {
  cheapProviderModelId: string;
  expensiveProviderModelId: string;
  unknownProviderModelId: string;
};

type GatewayChatInput = {
  apiKey: string;
  model: string;
  requestId: string;
};

type UsageCostRow = {
  baseline_cost_usd: string | null;
  baseline_provider_model_id: string | null;
  cost_source: string;
  input_cost_usd: string | null;
  input_tokens: number;
  output_cost_usd: string | null;
  output_tokens: number;
  price_source: string | null;
  provider_model_id: string | null;
  request_id: string;
  savings_usd: string | null;
  token_source: string;
  total_cost_usd: string | null;
  total_tokens: number;
};

async function seedUsageRoutes(
  fixture: Fixture,
  input: { agentApiKey: string; providerBaseUrl: string },
): Promise<SeededUsageRoutes> {
  const openaiProviderId = randomUUID();
  const unknownProviderId = randomUUID();
  const expensiveProviderModelId = randomUUID();
  const cheapProviderModelId = randomUUID();
  const unknownProviderModelId = randomUUID();
  const knownVirtualModelId = randomUUID();
  const unknownVirtualModelId = randomUUID();
  const knownRoutePolicyId = randomUUID();
  const unknownRoutePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', $2, true),
             ($3, 'api_key', 'unknown-usage-provider', 'Unknown Usage Provider', $2, true)
    `,
    [openaiProviderId, input.providerBaseUrl, unknownProviderId],
  );
  for (const providerId of [openaiProviderId, unknownProviderId]) {
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
  }
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
             ($3, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 128000, true, true, 'available'),
             ($4, $5, 'unknown-usage-model', 'Unknown Usage Model', 128000, true, true, 'available')
    `,
    [
      expensiveProviderModelId,
      openaiProviderId,
      cheapProviderModelId,
      unknownProviderModelId,
      unknownProviderId,
    ],
  );
  await fixture.query(
    `
      insert into provider_models_price (
        id,
        provider_key,
        model_id,
        input_usd_per_million_tokens,
        cached_input_usd_per_million_tokens,
        output_usd_per_million_tokens,
        source,
        source_url,
        price_version,
        synced_at
      )
      values ($1, 'openai', 'gpt-4.1', 2, null, 8, 'models.dev', 'test://prices/feat-045', 'test:feat-045', '2026-06-17T00:00:00.000Z'),
             ($2, 'openai', 'gpt-4.1-nano', 0.1, null, 0.4, 'models.dev', 'test://prices/feat-045', 'test:feat-045', '2026-06-17T00:00:00.000Z')
    `,
    [randomUUID(), randomUUID()],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'usage-cost-known', 'Usage Cost Known', true),
             ($2, 'usage-cost-unknown', 'Usage Cost Unknown', true)
    `,
    [knownVirtualModelId, unknownVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'cost_first'),
             ($3, $4, 'fixed')
    `,
    [knownRoutePolicyId, knownVirtualModelId, unknownRoutePolicyId, unknownVirtualModelId],
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
             ($4, $2, $5, 2, false),
             ($6, $7, $8, 1, false)
    `,
    [
      randomUUID(),
      knownRoutePolicyId,
      expensiveProviderModelId,
      randomUUID(),
      cheapProviderModelId,
      randomUUID(),
      unknownRoutePolicyId,
      unknownProviderModelId,
    ],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Usage Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      input.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.agentApiKey),
      knownVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3)
    `,
    [agentApiKeyId, knownVirtualModelId, unknownVirtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Usage cost config')",
  );

  return {
    cheapProviderModelId,
    expensiveProviderModelId,
    unknownProviderModelId,
  };
}

async function expectGatewayChat(baseUrl: string, input: GatewayChatInput): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 100,
      messages: [{ content: "hello from feat 045", role: "user" }],
      model: input.model,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: "fake-provider-response",
    object: "chat.completion",
  });
}

async function readUsageCostRows(fixture: Fixture): Promise<UsageCostRow[]> {
  const result = await fixture.query<UsageCostRow>(
    `
      select request_activity.request_id,
             request_usage.provider_model_id::text,
             request_usage.input_tokens,
             request_usage.output_tokens,
             request_usage.total_tokens,
             request_usage.token_source,
             request_costs.input_cost_usd::text,
             request_costs.output_cost_usd::text,
             request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.price_source,
             request_savings.baseline_provider_model_id::text,
             request_savings.baseline_cost_usd::text,
             request_savings.savings_usd::text
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      join request_savings on request_savings.request_activity_id = request_activity.id
      where request_activity.request_id in ('req_usage_known_045', 'req_usage_unknown_045')
      order by request_activity.request_id
    `,
  );
  return result.rows;
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
