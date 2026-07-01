import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  createAgent,
  listAgents,
  normalizeAgentFormInput,
  updateAgent,
} from "@llmingress/db/console-agents";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-agent-platform-status-103";
const gatewayAgentApiKey = "llmi_agent_platform_status_gateway_key_103";

test("agents persist integration platform request logging and derived status from recent activity and risks", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_platform_status_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const requestId = `req_agent_platform_status_${randomUUID()}`;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const created = await createAgent({
      agent: normalizeAgentFormInput({
        agentType: "coding",
        integrationPlatform: "codex",
        name: "Codex persisted",
        requestLoggingEnabled: false,
      }),
      databaseUrl: fixture.databaseUrl,
    });
    expect(created).toMatchObject({
      agentType: "coding",
      integrationPlatform: "codex",
      requestLoggingEnabled: false,
      status: "offline",
    });

    const updated = await updateAgent({
      agent: normalizeAgentFormInput({
        agentType: "terminal",
        integrationPlatform: "claude-code",
        name: "Claude persisted",
        requestLoggingEnabled: true,
      }),
      databaseUrl: fixture.databaseUrl,
      id: created.id,
    });
    expect(updated).toMatchObject({
      agentType: "terminal",
      integrationPlatform: "claude-code",
      requestLoggingEnabled: true,
    });
    await expect(readPersistedAgentFields(fixture, created.id)).resolves.toEqual({
      agent_type: "terminal",
      integration_platform: "claude-code",
      request_logging_enabled: true,
    });

    const statusAgents = await seedDerivedStatusAgents(fixture);
    const agents = await listAgents(fixture.databaseUrl);
    expect(agents.find((agent) => agent.id === statusAgents.offlineAgentId)).toMatchObject({
      name: "Offline Derived",
      status: "offline",
    });
    expect(agents.find((agent) => agent.id === statusAgents.onlineAgentId)).toMatchObject({
      name: "Online Derived",
      status: "online",
    });
    expect(agents.find((agent) => agent.id === statusAgents.highRiskAgentId)).toMatchObject({
      name: "High Risk Derived",
      status: "high-risk",
    });

    const loggingScenario = await seedGatewayLoggingScenario(fixture, {
      providerBaseUrl: `${provider.url}/v1`,
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
          max_tokens: 32,
          messages: [{ content: "Keep accounting without detailed logs.", role: "user" }],
          model: "logging-platform",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${gatewayAgentApiKey}`,
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      await expect(readGatewayAccountingActivity(fixture, requestId)).resolves.toEqual({
        cost_count: 1,
        error_message: null,
        fallback_attempts: [],
        http_status: 200,
        provider_id: loggingScenario.providerId,
        provider_model_id: loggingScenario.providerModelId,
        request_metadata: {},
        route_reason: {},
        status: "succeeded",
        usage_count: 1,
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

type PersistedAgentFields = {
  agent_type: string;
  integration_platform: string;
  request_logging_enabled: boolean;
};

type DerivedStatusAgents = {
  highRiskAgentId: string;
  offlineAgentId: string;
  onlineAgentId: string;
};

type GatewayLoggingScenario = {
  providerId: string;
  providerModelId: string;
};

type GatewayAccountingActivityRow = {
  cost_count: number;
  error_message: string | null;
  fallback_attempts: unknown[];
  http_status: number | null;
  provider_id: string | null;
  provider_model_id: string | null;
  request_metadata: Record<string, unknown>;
  route_reason: Record<string, unknown>;
  status: string;
  usage_count: number;
};

async function readPersistedAgentFields(
  fixture: Fixture,
  agentId: string,
): Promise<PersistedAgentFields | null> {
  const result = await fixture.query<PersistedAgentFields>(
    `
      select agent_type,
             integration_platform,
             request_logging_enabled
      from agents
      where id = $1
    `,
    [agentId],
  );
  return result.rows[0] ?? null;
}

async function seedDerivedStatusAgents(fixture: Fixture): Promise<DerivedStatusAgents> {
  const offlineAgentId = randomUUID();
  const onlineAgentId = randomUUID();
  const highRiskAgentId = randomUUID();
  const onlineAgentApiKeyId = randomUUID();
  const highRiskAgentApiKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const healthEventId = randomUUID();

  await fixture.query(
    `
      insert into agents (id, name, agent_type, enabled)
      values ($1, 'Offline Derived', 'coding', true),
             ($2, 'Online Derived', 'desktop', true),
             ($3, 'High Risk Derived', 'ide', true)
    `,
    [offlineAgentId, onlineAgentId, highRiskAgentId],
  );
  await fixture.query(
    `
      update agents
      set id = $1,
          key_prefix = 'online103',
          key_hash = 'hash-online-103',
          enabled = true,
          updated_at = now()
      where id = $2
    `,
    [onlineAgentApiKeyId, onlineAgentId],
  );
  await fixture.query(
    `
      update agents
      set id = $1,
          key_prefix = 'risk103',
          key_hash = 'hash-risk-103',
          enabled = true,
          updated_at = now()
      where id = $2
    `,
    [highRiskAgentApiKeyId, highRiskAgentId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        agent_key_prefix,
        protocol,
        model,
        status,
        started_at,
        completed_at
      )
      values ($1, $2, $3, 'online103', 'chat_completions', 'online-model', 'succeeded', now() - interval '5 minutes', now() - interval '5 minutes')
    `,
    [randomUUID(), `req-online-${randomUUID()}`, onlineAgentApiKeyId],
  );
  for (let index = 0; index < 5; index += 1) {
    await fixture.query(
      `
        insert into request_activity (
          id,
          request_id,
          agent_id,
          agent_key_prefix,
          protocol,
          model,
          status,
          started_at,
          completed_at,
          http_status
        )
        values ($1, $2, $3, 'risk103', 'chat_completions', 'risk-model', $4, now() - interval '10 minutes', now() - interval '10 minutes', $5)
      `,
      [
        randomUUID(),
        `req-risk-${index}-${randomUUID()}`,
        highRiskAgentApiKeyId,
        index < 3 ? "failed" : "succeeded",
        index < 3 ? 503 : 200,
      ],
    );
  }

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'risk-provider-103', 'Risk Provider 103', 'http://127.0.0.1:1/v1', true)
    `,
    [providerId],
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
      values ($1, $2, 'risk-provider-model-103', 'Risk Provider Model 103', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'risk-platform-status', 'Risk Platform Status', true)",
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
        candidate_order
      )
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
    [highRiskAgentApiKeyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        trigger,
        status,
        error_code,
        error_message
      )
      values ($1, $2, $3, 'request_path', 'unhealthy', 'seeded_unhealthy', 'Seeded unhealthy status')
    `,
    [healthEventId, providerId, providerModelId],
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
        last_failure_at
      )
      values ($1, $2, $3, $4, 'unhealthy', 4, now())
    `,
    [randomUUID(), providerId, providerModelId, healthEventId],
  );
  await fixture.query(
    `
      insert into agent_limits (
        id,
        agent_id,
        limit_type,
        period,
        limit_value,
        unit,
        enabled
      )
      values ($1, $2, 'rpm', 'minute', 1, 'requests', true)
    `,
    [randomUUID(), highRiskAgentApiKeyId],
  );
  await fixture.query(
    `
      insert into rate_limit_windows (
        id,
        agent_id,
        limit_type,
        window_start,
        window_end,
        request_count
      )
      values ($1, $2, 'rpm', now() - interval '30 seconds', now() + interval '30 seconds', 1)
    `,
    [randomUUID(), highRiskAgentApiKeyId],
  );

  return {
    highRiskAgentId: highRiskAgentApiKeyId,
    offlineAgentId,
    onlineAgentId: onlineAgentApiKeyId,
  };
}

async function seedGatewayLoggingScenario(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<GatewayLoggingScenario> {
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'logging-provider-103', 'Logging Provider 103', $2, true)
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
        availability,
        manual_input_usd_per_million_tokens,
        manual_output_usd_per_million_tokens,
        manual_price_updated_at
      )
      values ($1, $2, 'logging-provider-model-103', 'Logging Provider Model 103', 128000, true, true, 'available', 1, 2, now())
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'logging-platform', 'Logging Platform', true)
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
        candidate_order
      )
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        integration_platform,
        request_logging_enabled,
        enabled
      )
      values ($1, 'Logging Disabled Agent', 'coding', 'codex', false, true)
    `,
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      gatewayAgentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(gatewayAgentApiKey),
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
    "insert into config_versions (version, source, description) values (103, 'console', 'Agent platform logging config')",
  );

  return { providerId, providerModelId };
}

async function readGatewayAccountingActivity(
  fixture: Fixture,
  requestId: string,
): Promise<GatewayAccountingActivityRow | null> {
  const result = await fixture.query<GatewayAccountingActivityRow>(
    `
      select request_activity.status,
             request_activity.http_status,
             request_activity.provider_id::text,
             request_activity.provider_model_id::text,
             request_activity.request_metadata,
             request_activity.route_reason,
             request_activity.fallback_attempts,
             request_activity.error_message,
             (
               select count(*)::integer
               from request_usage
               where request_usage.request_activity_id = request_activity.id
             ) as usage_count,
             (
               select count(*)::integer
               from request_costs
               where request_costs.request_activity_id = request_activity.id
             ) as cost_count
      from request_activity
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
