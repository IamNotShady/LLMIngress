import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { defaultAgentLimitFormValues } from "../../apps/console/src/server/agent-limits";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  buildHermesLikeOpenAICompatibleChatBody,
  realAgentOpenAICompatibleSmokeNames,
} from "../support/real-agent-openai-compatible-smoke";

const masterKey = "test-master-key";

test("Hermes-like OpenAI-compatible agent request succeeds with default limits and records usage", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_real_agent_openai_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRealAgentOpenAICompatibleGateway(fixture, {
      providerBaseUrl: `${provider.url}/v1`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const requestBody = buildHermesLikeOpenAICompatibleChatBody();
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify(requestBody),
        headers: {
          authorization: `Bearer ${realAgentOpenAICompatibleSmokeNames.agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": realAgentOpenAICompatibleSmokeNames.requestId,
        },
        method: "POST",
      });
      const responseBody = await response.json();

      expect(response.status).toBe(200);
      expect(responseBody).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
        id: "fake-provider-response",
        object: "chat.completion",
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.path).toBe("/v1/chat/completions");
      expect(provider.requests[0]?.headers.authorization).toBe(
        `Bearer ${realAgentOpenAICompatibleSmokeNames.providerApiKey}`,
      );
      expect(provider.requests[0]?.bodyJson).toMatchObject({
        max_tokens: requestBody.max_tokens,
        messages: requestBody.messages,
        model: realAgentOpenAICompatibleSmokeNames.providerModel,
        stream: false,
        temperature: requestBody.temperature,
        tool_choice: "auto",
        tools: requestBody.tools,
      });

      await expect
        .poll(() => readSmokeRuntimeRow(fixture, realAgentOpenAICompatibleSmokeNames.requestId))
        .toMatchObject({
          cost_source: "estimated",
          http_status: 200,
          output_tokens: requestBody.max_tokens,
          provider_model_id: seeded.providerModelId,
          request_id: realAgentOpenAICompatibleSmokeNames.requestId,
          status: "succeeded",
          token_source: "estimated",
        });

      const runtimeRow = await readSmokeRuntimeRow(
        fixture,
        realAgentOpenAICompatibleSmokeNames.requestId,
      );
      expect(runtimeRow?.input_tokens).toBeGreaterThan(5_000);
      expect(runtimeRow?.total_tokens).toBeLessThanOrEqual(defaultAgentLimitFormValues.tokenLimit);
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

type SeededRealAgentOpenAICompatibleGateway = {
  providerModelId: string;
};

type SmokeRuntimeRow = {
  cost_source: string;
  http_status: number;
  input_tokens: number;
  output_tokens: number;
  provider_model_id: string | null;
  request_id: string;
  status: string;
  token_source: string;
  total_tokens: number;
};

async function seedRealAgentOpenAICompatibleGateway(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<SeededRealAgentOpenAICompatibleGateway> {
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const routePolicyId = randomUUID();
  const virtualModelId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    realAgentOpenAICompatibleSmokeNames.providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Real Agent OpenAI Provider', $2, true)
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
      realAgentOpenAICompatibleSmokeNames.providerApiKey.slice(0, 8),
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
      values ($1, $2, $3, 'GPT 4.1 Mini', 128000, true, true, 'available')
    `,
    [providerModelId, providerId, realAgentOpenAICompatibleSmokeNames.providerModel],
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = 0.4,
          synced_cached_input_usd_per_million_tokens = null,
          synced_output_usd_per_million_tokens = 1.6,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'test://prices/feat-059',
          synced_price_version = 'test:feat-059',
          synced_price_synced_at = '2026-06-17T00:00:00.000Z',
          synced_price_updated_at = '2026-06-17T00:00:00.000Z'
      where model_id = $1
    `,
    [realAgentOpenAICompatibleSmokeNames.providerModel],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, 'Real Agent OpenAI Compatible Smoke', true)",
    [virtualModelId, realAgentOpenAICompatibleSmokeNames.virtualModel],
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
        candidate_order
      )
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Real Agent OpenAI Smoke Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      realAgentOpenAICompatibleSmokeNames.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(realAgentOpenAICompatibleSmokeNames.agentApiKey),
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
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'rpm', 'minute', $3, 'requests', true),
             ($4, $2, 'tpm', 'minute', $5, 'tokens', true),
             ($6, $2, 'token', 'request', $7, 'tokens', true),
             ($8, $2, 'budget', 'month', $9, 'usd', true)
    `,
    [
      randomUUID(),
      agentApiKeyId,
      defaultAgentLimitFormValues.rpm,
      randomUUID(),
      defaultAgentLimitFormValues.tpm,
      randomUUID(),
      defaultAgentLimitFormValues.tokenLimit,
      randomUUID(),
      defaultAgentLimitFormValues.budgetUsd,
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Real Agent OpenAI-compatible smoke config')",
  );

  return { providerModelId };
}

async function readSmokeRuntimeRow(
  fixture: Fixture,
  requestId: string,
): Promise<SmokeRuntimeRow | null> {
  const result = await fixture.query<SmokeRuntimeRow>(
    `
      select request_activity.request_id,
             request_activity.status,
             request_activity.http_status,
             request_activity.provider_model_id::text,
             request_usage.input_tokens,
             request_usage.output_tokens,
             request_usage.total_tokens,
             request_usage.token_source,
             request_costs.cost_source
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      where request_activity.request_id = $1
    `,
    [requestId],
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
    gateway.child.once("exit", () => resolve());
    setTimeout(() => {
      if (gateway.child.exitCode === null) {
        gateway.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
