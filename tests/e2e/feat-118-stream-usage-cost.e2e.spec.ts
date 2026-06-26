import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-stream-usage-118";
const agentApiKey = "llmi_stream_usage_gateway_key_118";

test("streaming requests record usage cost for chat responses and messages", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stream_usage_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedStreamUsageRoutes(fixture, {
      chatBaseUrl: `${provider.url}/v1?mode=stream&usage=chat`,
      messagesBaseUrl: `${provider.url}/v1?mode=stream&usage=messages`,
      noUsageBaseUrl: `${provider.url}/v1?mode=stream`,
      responsesBaseUrl: `${provider.url}/v1?mode=stream&usage=responses`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectStreamRequest(baseUrl, {
        body: {
          max_tokens: 200,
          messages: [{ content: "stream usage chat", role: "user" }],
          model: "stream-usage-chat",
          stream: true,
        },
        path: "/v1/chat/completions",
        requestId: "req_stream_usage_chat_118",
      });
      await expectStreamRequest(baseUrl, {
        body: {
          input: "stream usage responses",
          max_output_tokens: 25,
          model: "stream-usage-responses",
          stream: true,
        },
        path: "/v1/responses",
        requestId: "req_stream_usage_responses_118",
      });
      await expectStreamRequest(baseUrl, {
        body: {
          max_tokens: 30,
          messages: [{ content: "stream usage messages", role: "user" }],
          model: "stream-usage-messages",
          stream: true,
        },
        path: "/v1/messages",
        requestId: "req_stream_usage_messages_118",
      });
      await expectStreamRequest(baseUrl, {
        body: {
          max_tokens: 10,
          messages: [{ content: "stream no usage", role: "user" }],
          model: "stream-usage-estimated",
          stream: true,
        },
        path: "/v1/chat/completions",
        requestId: "req_stream_usage_estimated_118",
      });

      await expect.poll(() => countUsageRows(fixture), { timeout: 10_000 }).toBe(4);
      const rows = await readStreamUsageRows(fixture);

      expect(rows.find((row) => row.request_id === "req_stream_usage_chat_118")).toMatchObject({
        baseline_cost_usd: "0.00300000",
        baseline_provider_model_id: seeded.chatBaselineProviderModelId,
        cached_input_tokens: 400,
        cost_source: "estimated",
        input_cost_usd: "0.00007000",
        input_tokens: 1000,
        output_cost_usd: "0.00008000",
        output_tokens: 200,
        provider_model_id: seeded.chatActualProviderModelId,
        response_input_tokens: "1000",
        token_source: "provider",
        total_cost_usd: "0.00015000",
        total_tokens: 1200,
      });
      expect(rows.find((row) => row.request_id === "req_stream_usage_responses_118")).toMatchObject(
        {
          input_tokens: 50,
          output_tokens: 25,
          provider_model_id: seeded.responsesActualProviderModelId,
          response_input_tokens: "50",
          token_source: "provider",
          total_cost_usd: "0.00001425",
          total_tokens: 75,
        },
      );
      expect(rows.find((row) => row.request_id === "req_stream_usage_messages_118")).toMatchObject({
        cached_input_tokens: 5,
        input_tokens: 65,
        output_tokens: 30,
        provider_model_id: seeded.messagesActualProviderModelId,
        response_input_tokens: "65",
        token_source: "provider",
        total_cost_usd: "0.00001813",
        total_tokens: 95,
      });

      const estimatedRow = rows.find((row) => row.request_id === "req_stream_usage_estimated_118");
      expect(estimatedRow).toMatchObject({
        provider_model_id: seeded.estimatedActualProviderModelId,
        response_input_tokens: null,
        token_source: "estimated",
      });
      expect(estimatedRow?.input_tokens).toBeGreaterThan(0);
      expect(estimatedRow?.output_tokens).toBe(10);
      expect(estimatedRow?.total_cost_usd).not.toBeNull();

      const chatProviderRequest = provider.requests.find(
        (request) => request.path === "/v1/chat/completions" && request.mode === "stream",
      );
      expect(chatProviderRequest?.bodyJson).toMatchObject({
        stream_options: { include_usage: true },
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

type SeededStreamUsageRoutes = {
  chatActualProviderModelId: string;
  chatBaselineProviderModelId: string;
  estimatedActualProviderModelId: string;
  messagesActualProviderModelId: string;
  responsesActualProviderModelId: string;
};

type StreamUsageRow = {
  baseline_cost_usd: string | null;
  baseline_provider_model_id: string | null;
  cached_input_tokens: number;
  cost_source: string;
  input_cost_usd: string | null;
  input_tokens: number;
  output_cost_usd: string | null;
  output_tokens: number;
  provider_model_id: string | null;
  request_id: string;
  response_input_tokens: string | null;
  token_source: string;
  total_cost_usd: string | null;
  total_tokens: number;
};

type ProviderSpec = {
  actualModelId: string;
  baseUrl: string;
  baselineModelId: string;
  modelName: string;
  providerId: string;
  providerKey: string;
  virtualModelId: string;
  virtualModelName: string;
};

async function seedStreamUsageRoutes(
  fixture: Fixture,
  input: {
    chatBaseUrl: string;
    messagesBaseUrl: string;
    noUsageBaseUrl: string;
    responsesBaseUrl: string;
  },
): Promise<SeededStreamUsageRoutes> {
  const providers: ProviderSpec[] = [
    buildProviderSpec("openai", input.chatBaseUrl, "stream-usage-chat", "chat"),
    buildProviderSpec("openai", input.responsesBaseUrl, "stream-usage-responses", "responses"),
    buildProviderSpec("anthropic", input.messagesBaseUrl, "stream-usage-messages", "messages"),
    buildProviderSpec("openai", input.noUsageBaseUrl, "stream-usage-estimated", "estimated"),
  ];
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  for (const spec of providers) {
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, $3, $4, true)
      `,
      [spec.providerId, spec.providerKey, `Stream Usage ${spec.virtualModelName}`, spec.baseUrl],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, $3, $4, $5)
      `,
      [
        randomUUID(),
        spec.providerId,
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
        values ($1, $3, 'gpt-4.1', 'GPT 4.1', 128000, true, true, 'available'),
               ($2, $3, $4, $5, 128000, true, true, 'available')
      `,
      [
        spec.baselineModelId,
        spec.actualModelId,
        spec.providerId,
        spec.modelName,
        `Actual ${spec.virtualModelName}`,
      ],
    );
    await fixture.query(
      `
        update provider_models
        set synced_input_usd_per_million_tokens = prices.input_price,
            synced_cached_input_usd_per_million_tokens = prices.cached_input_price,
            synced_output_usd_per_million_tokens = prices.output_price,
            synced_price_source = 'models.dev',
            synced_price_source_url = 'test://prices/feat-118',
            synced_price_version = 'test:feat-118',
            synced_price_synced_at = '2026-06-25T00:00:00.000Z',
            synced_price_updated_at = '2026-06-25T00:00:00.000Z'
        from (
          values
            ('gpt-4.1', 2::numeric, 0.5::numeric, 8::numeric),
            ($1::text, 0.1::numeric, 0.025::numeric, 0.4::numeric)
        ) as prices(model_id, input_price, cached_input_price, output_price)
        where provider_models.provider_id = $2
          and provider_models.model_id = prices.model_id
      `,
      [spec.modelName, spec.providerId],
    );
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
      [spec.virtualModelId, spec.virtualModelName, spec.virtualModelName],
    );
    const routePolicyId = randomUUID();
    await fixture.query(
      "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
      [routePolicyId, spec.virtualModelId],
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
      [randomUUID(), routePolicyId, spec.baselineModelId, randomUUID(), spec.actualModelId],
    );
  }

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Stream Usage Agent', 'coding', true)",
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
      providers[0]?.virtualModelId,
    ],
  );
  for (const spec of providers) {
    await fixture.query(
      "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
      [agentApiKeyId, spec.virtualModelId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Stream usage config')",
  );

  return {
    chatActualProviderModelId: providers[0]?.actualModelId ?? "",
    chatBaselineProviderModelId: providers[0]?.baselineModelId ?? "",
    estimatedActualProviderModelId: providers[3]?.actualModelId ?? "",
    messagesActualProviderModelId: providers[2]?.actualModelId ?? "",
    responsesActualProviderModelId: providers[1]?.actualModelId ?? "",
  };
}

function buildProviderSpec(
  providerKey: string,
  baseUrl: string,
  virtualModelName: string,
  suffix: string,
): ProviderSpec {
  return {
    actualModelId: randomUUID(),
    baseUrl,
    baselineModelId: randomUUID(),
    modelName: `stream-usage-${suffix}-actual`,
    providerId: randomUUID(),
    providerKey,
    virtualModelId: randomUUID(),
    virtualModelName,
  };
}

async function expectStreamRequest(
  baseUrl: string,
  input: {
    body: Record<string, unknown>;
    path: "/v1/chat/completions" | "/v1/messages" | "/v1/responses";
    requestId: string;
  },
): Promise<void> {
  const response = await fetch(`${baseUrl}${input.path}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${agentApiKey}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await expect(response.text()).resolves.toContain("data: [DONE]");
}

async function countUsageRows(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    `
      select count(*)::text as count
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      where request_activity.request_id like 'req_stream_usage_%_118'
    `,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function readStreamUsageRows(fixture: Fixture): Promise<StreamUsageRow[]> {
  const result = await fixture.query<StreamUsageRow>(
    `
      select request_activity.request_id,
             request_usage.provider_model_id::text,
             request_usage.input_tokens,
             request_usage.output_tokens,
             request_usage.total_tokens,
             request_usage.cached_input_tokens,
             request_usage.token_source,
             request_costs.input_cost_usd::text,
             request_costs.output_cost_usd::text,
             request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.baseline_provider_model_id::text,
             request_costs.baseline_cost_usd::text,
             request_activity.response_metadata #>> '{tokenUsage,inputTokens}' as response_input_tokens
      from request_activity
      join request_usage on request_usage.request_activity_id = request_activity.id
      join request_costs on request_costs.request_activity_id = request_activity.id
      where request_activity.request_id like 'req_stream_usage_%_118'
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
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
      NODE_ENV: "test",
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
