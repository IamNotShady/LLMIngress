import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-cache-071";
const agentApiKey = "llmi_prompt_cache_gateway_key_071";

test("prompt caching tokens use cached input pricing fallback and affect usage cost savings records", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_prompt_cache_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedPromptCachingRoute(fixture, {
      providerBaseUrl: `${provider.url}/v1?mode=cached-usage`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          max_tokens: 200,
          messages: [{ content: "use provider cached token accounting", role: "user" }],
          model: "prompt-cache-coding",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_prompt_cache_071",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "fake-provider-cached-usage",
        object: "chat.completion",
      });

      await expect
        .poll(() => readPromptCachingCostRow(fixture))
        .toEqual({
          actual_cost_usd: "0.00015000",
          baseline_cost_usd: "0.00300000",
          baseline_provider_model_id: seeded.baselineProviderModelId,
          cached_input_tokens: 400,
          cost_source: "estimated",
          input_cost_usd: "0.00007000",
          input_tokens: 1000,
          output_cost_usd: "0.00008000",
          output_tokens: 200,
          price_source: "price_sync",
          provider_model_id: seeded.actualProviderModelId,
          reasoning_tokens: 25,
          request_id: "req_prompt_cache_071",
          savings_usd: "0.00285000",
          token_source: "provider",
          total_cost_usd: "0.00015000",
          total_tokens: 1200,
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

type SeededPromptCachingRoute = {
  actualProviderModelId: string;
  baselineProviderModelId: string;
};

type PromptCachingCostRow = {
  actual_cost_usd: string;
  baseline_cost_usd: string;
  baseline_provider_model_id: string;
  cached_input_tokens: number;
  cost_source: string;
  input_cost_usd: string;
  input_tokens: number;
  output_cost_usd: string;
  output_tokens: number;
  price_source: string | null;
  provider_model_id: string;
  reasoning_tokens: number;
  request_id: string;
  savings_usd: string;
  token_source: string;
  total_cost_usd: string;
  total_tokens: number;
};

async function seedPromptCachingRoute(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<SeededPromptCachingRoute> {
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
      values ($1, 'openai', 'gpt-4.1', 2, 0.5, 8, 'models.dev', 'test://prices/feat-071', 'test:feat-071', '2026-06-17T00:00:00.000Z'),
             ($2, 'openai', 'gpt-4.1-nano', 0.1, 0.025, 0.4, 'models.dev', 'test://prices/feat-071', 'test:feat-071', '2026-06-17T00:00:00.000Z')
    `,
    [randomUUID(), randomUUID()],
  );
  await fixture.query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, 'prompt-cache-coding', 'Prompt Cache Coding', true)",
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
        candidate_order,
        is_fallback
      )
      values ($1, $2, $3, 1, false),
             ($4, $2, $5, 2, false)
    `,
    [randomUUID(), routePolicyId, baselineProviderModelId, randomUUID(), actualProviderModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Prompt Cache Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
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
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Prompt caching config')",
  );

  return { actualProviderModelId, baselineProviderModelId };
}

async function readPromptCachingCostRow(fixture: Fixture): Promise<PromptCachingCostRow | null> {
  const result = await fixture.query<PromptCachingCostRow>(
    `
      select request_activity.request_id,
             request_usage.provider_model_id::text,
             request_usage.input_tokens,
             request_usage.output_tokens,
             request_usage.total_tokens,
             request_usage.cached_input_tokens,
             request_usage.reasoning_tokens,
             request_usage.token_source,
             request_costs.input_cost_usd::text,
             request_costs.output_cost_usd::text,
             request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.price_source,
             request_savings.baseline_provider_model_id::text,
             request_savings.actual_cost_usd::text,
             request_savings.baseline_cost_usd::text,
             request_savings.savings_usd::text
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      join request_savings on request_savings.request_activity_id = request_activity.id
      where request_activity.request_id = 'req_prompt_cache_071'
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
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
      NODE_ENV: "test",
    },
  });
  const gateway: GatewayProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stdout.on("data", (chunk) => {
    gateway.stdout.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    gateway.stderr.push(String(chunk));
  });
  return gateway;
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      gateway.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    gateway.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    gateway.child.kill("SIGTERM");
  });
}
