import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-budget-042";

test("budget reservation finalization over budget 402 and unknown price model requires manual price", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_budget_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const tokenKey = "llmi_token_budget_key_042";
  const costKey = "llmi_cost_budget_key_042";
  const unknownPriceKey = "llmi_unknown_price_budget_key_042";
  const manualPriceKey = "llmi_manual_price_budget_key_042";
  const anthropicBuiltInPriceKey = "llmi_anthropic_budget_key_042";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedBudgetRoutes(fixture, {
      costKey,
      anthropicBuiltInPriceKey,
      manualPriceKey,
      providerBaseUrl: `${provider.url}/v1`,
      tokenKey,
      unknownPriceKey,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectGatewayChat(baseUrl, {
        apiKey: tokenKey,
        expectedCode: "token_budget_exceeded",
        maxTokens: 128,
        model: "token-budget-coding",
        requestId: "req_token_over_budget_042",
        status: 402,
      });
      expect(provider.requests).toHaveLength(0);

      await expectGatewayChat(baseUrl, {
        apiKey: costKey,
        maxTokens: 64,
        model: "cost-budget-coding",
        requestId: "req_cost_first_042",
        status: 200,
      });
      expect(provider.requests).toHaveLength(1);
      await expectFinalizedBudget(fixture, seeded.costAgentApiKeyId);

      await expectGatewayChat(baseUrl, {
        apiKey: costKey,
        expectedCode: "cost_budget_exceeded",
        maxTokens: 64,
        model: "cost-budget-coding",
        requestId: "req_cost_over_budget_042",
        status: 402,
      });
      expect(provider.requests).toHaveLength(1);

      await expectGatewayChat(baseUrl, {
        apiKey: unknownPriceKey,
        expectedCode: "cost_budget_price_unavailable",
        maxTokens: 16,
        model: "unknown-price-budget-coding",
        requestId: "req_unknown_price_042",
        status: 402,
      });
      expect(provider.requests).toHaveLength(1);

      await expectGatewayChat(baseUrl, {
        apiKey: manualPriceKey,
        maxTokens: 16,
        model: "manual-price-budget-coding",
        requestId: "req_manual_price_042",
        status: 200,
      });
      expect(provider.requests).toHaveLength(2);

      await expectGatewayChat(baseUrl, {
        apiKey: anthropicBuiltInPriceKey,
        maxTokens: 16,
        model: "anthropic-built-in-price-budget-coding",
        requestId: "req_anthropic_builtin_price_042",
        status: 200,
      });
      expect(provider.requests).toHaveLength(3);
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

type BudgetSeed = {
  costAgentApiKeyId: string;
};

type ChatExpectation = {
  apiKey: string;
  expectedCode?: string;
  maxTokens: number;
  model: string;
  requestId: string;
  status: 200 | 402;
};

async function seedBudgetRoutes(
  fixture: Fixture,
  input: {
    costKey: string;
    anthropicBuiltInPriceKey: string;
    manualPriceKey: string;
    providerBaseUrl: string;
    tokenKey: string;
    unknownPriceKey: string;
  },
): Promise<BudgetSeed> {
  const agentId = randomUUID();
  const tokenAgentApiKeyId = randomUUID();
  const costAgentApiKeyId = randomUUID();
  const unknownPriceAgentApiKeyId = randomUUID();
  const manualPriceAgentApiKeyId = randomUUID();
  const anthropicBuiltInPriceAgentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );
  const routes = [
    {
      key: input.tokenKey,
      providerKey: "token-budget-provider",
      providerModel: "gpt-4.1-mini",
      virtualModel: "token-budget-coding",
      agentApiKeyId: tokenAgentApiKeyId,
    },
    {
      key: input.costKey,
      providerKey: "openai",
      providerModel: "gpt-4.1-mini",
      virtualModel: "cost-budget-coding",
      agentApiKeyId: costAgentApiKeyId,
    },
    {
      key: input.unknownPriceKey,
      providerKey: "unknown-budget-provider",
      providerModel: "unknown-budget-model",
      virtualModel: "unknown-price-budget-coding",
      agentApiKeyId: unknownPriceAgentApiKeyId,
    },
    {
      key: input.manualPriceKey,
      providerKey: "manual-budget-provider",
      providerModel: "manual-budget-model",
      virtualModel: "manual-price-budget-coding",
      agentApiKeyId: manualPriceAgentApiKeyId,
    },
    {
      key: input.anthropicBuiltInPriceKey,
      providerKey: "anthropic",
      providerModel: "claude-sonnet-4-6",
      virtualModel: "anthropic-built-in-price-budget-coding",
      agentApiKeyId: anthropicBuiltInPriceAgentApiKeyId,
    },
  ];

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Budget Agent', 'coding', true)",
    [agentId],
  );

  for (const route of routes) {
    const providerId = randomUUID();
    const providerModelId = randomUUID();
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();

    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, $3, $4, true)
      `,
      [providerId, route.providerKey, route.providerKey, input.providerBaseUrl],
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
        values ($1, $2, $3, $4, 128000, true, true, 'available')
      `,
      [providerModelId, providerId, route.providerModel, route.providerModel],
    );
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
      [virtualModelId, route.virtualModel, route.virtualModel],
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
        values ($1, $2, $3, 1, false)
      `,
      [randomUUID(), routePolicyId, providerModelId],
    );
    await fixture.query(
      `
        insert into agents (
          id,
          name,
          agent_type,
          key_prefix,
          key_hash,
          default_virtual_model_id,
          enabled
        )
        values ($1, 'Budget Agent', 'coding', $2, $3, $4, true)
      `,
      [
        route.agentApiKeyId,
        route.key.slice(0, 12),
        buildGatewayAgentApiKeyHash(route.key),
        virtualModelId,
      ],
    );
    await fixture.query(
      `
        insert into agent_virtual_models (agent_id, virtual_model_id)
        values ($1, $2)
      `,
      [route.agentApiKeyId, virtualModelId],
    );
  }

  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'token', 'request', 80, 'tokens', true),
             ($3, $4, 'budget', 'month', 0.00015, 'usd', true),
             ($5, $6, 'budget', 'month', 1, 'usd', true),
             ($7, $8, 'budget', 'month', 1, 'usd', true),
             ($9, $10, 'budget', 'month', 1, 'usd', true)
    `,
    [
      randomUUID(),
      tokenAgentApiKeyId,
      randomUUID(),
      costAgentApiKeyId,
      randomUUID(),
      unknownPriceAgentApiKeyId,
      randomUUID(),
      manualPriceAgentApiKeyId,
      randomUUID(),
      anthropicBuiltInPriceAgentApiKeyId,
    ],
  );
  await fixture.query(
    `
      update provider_models
      set manual_input_usd_per_million_tokens = 0.5,
          manual_output_usd_per_million_tokens = 1.5,
          manual_price_updated_at = now()
      from providers
      where providers.id = provider_models.provider_id
        and providers.provider_key = 'manual-budget-provider'
        and provider_models.model_id = 'manual-budget-model'
    `,
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = prices.input_price,
          synced_output_usd_per_million_tokens = prices.output_price,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'https://models.dev/api.json',
          synced_price_version = 'models.dev:042',
          synced_price_synced_at = now(),
          synced_price_updated_at = now()
      from (
        values
          ('gpt-4.1-mini', 0.40::numeric, 1.60::numeric),
          ('claude-sonnet-4-6', 3.00::numeric, 15.00::numeric)
      ) as prices(model_id, input_price, output_price)
      where provider_models.model_id = prices.model_id
    `,
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Budget config')",
  );

  return { costAgentApiKeyId };
}

async function expectGatewayChat(baseUrl: string, expectation: ChatExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: expectation.maxTokens,
      messages: [{ content: "hello budget", role: "user" }],
      model: expectation.model,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${expectation.apiKey}`,
      "content-type": "application/json",
      "x-request-id": expectation.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(expectation.status);
  const body = await response.json();

  if (expectation.status === 402) {
    expect(body).toEqual({
      error: {
        code: expectation.expectedCode,
        message: expect.any(String),
      },
      requestId: expectation.requestId,
    });
    return;
  }

  expect(body).toMatchObject({
    id: "fake-provider-response",
    object: "chat.completion",
  });
}

async function expectFinalizedBudget(fixture: Fixture, agentApiKeyId: string): Promise<void> {
  await expect
    .poll(async () => {
      const result = await fixture.query<{
        cost_used_usd: string;
        reservations: string;
        reserved_cost_usd: string;
        status: string;
      }>(
        `
          select budget_periods.cost_used_usd::text,
                 budget_periods.reserved_cost_usd::text,
                 count(budget_reservations.id)::text as reservations,
                 max(budget_reservations.status) as status
          from budget_periods
          join budget_reservations on budget_reservations.budget_period_id = budget_periods.id
          where budget_periods.agent_id = $1
          group by budget_periods.id
        `,
        [agentApiKeyId],
      );
      return result.rows[0] ?? null;
    })
    .toMatchObject({
      reservations: "1",
      reserved_cost_usd: "0.00000000",
      status: "finalized",
    });
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
