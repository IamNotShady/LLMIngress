import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-embeddings-067";
const agentApiKey = "llmi_embeddings_gateway_key_067";
const providerModelIdText = "text-embedding-3-small";

test("embeddings endpoint authenticates routes records activity usage cost and rejects disallowed virtual model without provider call", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_embeddings_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedEmbeddingsRoute(fixture, {
      providerBaseUrl: `${provider.url}/v1?mode=embeddings`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const blockedResponse = await fetch(`${baseUrl}/v1/embeddings`, {
        body: JSON.stringify({
          input: "blocked embeddings text",
          model: "blocked-embeddings",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_embeddings_blocked_067",
        },
        method: "POST",
      });

      expect(blockedResponse.status).toBe(403);
      await expect(blockedResponse.json()).resolves.toMatchObject({
        error: { code: "virtual_model_not_allowed" },
        requestId: "req_embeddings_blocked_067",
      });
      expect(provider.requests).toHaveLength(0);

      const response = await fetch(`${baseUrl}/v1/embeddings`, {
        body: JSON.stringify({
          dimensions: 256,
          encoding_format: "float",
          input: ["hello embeddings"],
          model: "embedding-coding",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_embeddings_allowed_067",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: "embedding" }],
        model: providerModelIdText,
        object: "list",
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        bodyJson: {
          dimensions: 256,
          encoding_format: "float",
          input: ["hello embeddings"],
          model: providerModelIdText,
        },
        method: "POST",
        path: "/v1/embeddings",
      });
      expect(provider.requests[0]?.headers.authorization).toBe(`Bearer ${providerApiKey}`);

      await expectEmbeddingsRuntimeRows(fixture);
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

async function seedEmbeddingsRoute(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const allowedVirtualModelId = randomUUID();
  const blockedVirtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const blockedRoutePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-openai-embeddings', 'Fake OpenAI Embeddings', $2, true)
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
      values ($1, $2, $3, 'Text Embedding 3 Small', 8191, false, false, 'available')
    `,
    [providerModelId, providerId, providerModelIdText],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'embedding-coding', 'Embedding Coding', true),
             ($2, 'blocked-embeddings', 'Blocked Embeddings', true)
    `,
    [allowedVirtualModelId, blockedVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed'),
             ($3, $4, 'fixed')
    `,
    [routePolicyId, allowedVirtualModelId, blockedRoutePolicyId, blockedVirtualModelId],
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
             ($4, $5, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId, randomUUID(), blockedRoutePolicyId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Embeddings Agent', 'coding', true)",
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
      allowedVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, allowedVirtualModelId],
  );
  await fixture.query(
    `
      update provider_models
      set manual_input_usd_per_million_tokens = 0.02,
          manual_output_usd_per_million_tokens = 0,
          manual_price_updated_at = now()
      where id = $1
    `,
    [providerModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Embeddings route config')",
  );
}

async function expectEmbeddingsRuntimeRows(fixture: Fixture): Promise<void> {
  const result = await fixture.query<{
    cost_source: string;
    http_status: number;
    input_tokens: number;
    output_tokens: number;
    protocol: string;
    request_id: string;
    status: string;
    token_source: string;
    total_cost_usd: string;
    total_tokens: number;
  }>(
    `
      select request_activity.request_id,
             request_activity.protocol,
             request_activity.status,
             request_activity.http_status,
             request_usage.input_tokens,
             request_usage.output_tokens,
             request_usage.total_tokens,
             request_usage.token_source,
             request_costs.total_cost_usd::text,
             request_costs.cost_source
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      where request_activity.request_id = 'req_embeddings_allowed_067'
    `,
  );

  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    cost_source: "estimated",
    http_status: 200,
    output_tokens: 0,
    protocol: "embeddings",
    request_id: "req_embeddings_allowed_067",
    status: "succeeded",
    token_source: "provider",
  });
  expect(result.rows[0]?.input_tokens).toBeGreaterThan(0);
  expect(result.rows[0]?.total_tokens).toBe(result.rows[0]?.input_tokens);
  expect(Number(result.rows[0]?.total_cost_usd)).toBeGreaterThan(0);
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
