import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const badProviderApiKey = "bad-provider-key-070";
const goodProviderApiKey = "sk-good-provider-key-070";
const fallbackProviderApiKey = "sk-fallback-provider-key-070";
const agentApiKey = "llmi_multi_key_gateway_key_070";

test("provider multi key schema accepts multiple keys and failover records failed key attempts before fallback", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_multi_key_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedMultiKeyGateway(fixture, {
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
          messages: [{ content: "try provider keys before fallback", role: "user" }],
          model: "multi-key-coding",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_multi_key_070",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(provider.requests.map((request) => request.bodyJson)).toEqual([
        expect.objectContaining({ model: "primary-model" }),
        expect.objectContaining({ model: "primary-model" }),
      ]);
      expect(provider.requests.map((request) => request.headers.authorization)).toEqual([
        `Bearer ${badProviderApiKey}`,
        `Bearer ${goodProviderApiKey}`,
      ]);

      await expectFallbackEvents(fixture, [
        {
          attempt_order: 1,
          error_code: "invalid_api_key",
          failed_before_first_byte: false,
          provider_api_key_id: seeded.badProviderApiKeyId,
          provider_api_key_prefix: badProviderApiKey.slice(0, 8),
          provider_model_id: seeded.primaryProviderModelId,
          status: "failed",
        },
      ]);
      await expectActivity(fixture, {
        fallback_attempts: [
          expect.objectContaining({
            providerApiKeyId: seeded.badProviderApiKeyId,
            providerApiKeyPrefix: badProviderApiKey.slice(0, 8),
            providerModelId: seeded.primaryProviderModelId,
          }),
        ],
        provider_model_id: seeded.primaryProviderModelId,
        request_id: "req_multi_key_070",
        status: "succeeded",
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

type SeededMultiKeyGateway = {
  badProviderApiKeyId: string;
  primaryProviderModelId: string;
};

type FallbackEventRow = {
  attempt_order: number;
  error_code: string | null;
  failed_before_first_byte: boolean;
  provider_api_key_id: string | null;
  provider_api_key_prefix: string | null;
  provider_model_id: string;
  status: string;
};

type ActivityRow = {
  fallback_attempts: unknown;
  provider_model_id: string;
  request_id: string;
  status: string;
};

async function seedMultiKeyGateway(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<SeededMultiKeyGateway> {
  const primaryProviderId = randomUUID();
  const fallbackProviderId = randomUUID();
  const primaryProviderModelId = randomUUID();
  const fallbackProviderModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const badProviderApiKeyId = randomUUID();
  const encryption = createSecretEncryption({ kind: "inline", value: masterKey });

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'multi-key-primary', 'Multi Key Primary', $2, true),
             ($3, 'api_key', 'multi-key-fallback', 'Multi Key Fallback', $2, true)
    `,
    [primaryProviderId, input.providerBaseUrl, fallbackProviderId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, created_at)
      values ($1, $2, $3, $4, $5, '2026-01-01T00:00:00Z'),
             ($6, $2, $7, $8, $9, '2026-01-01T00:00:01Z'),
             ($10, $11, $12, $13, $14, '2026-01-01T00:00:00Z')
    `,
    [
      badProviderApiKeyId,
      primaryProviderId,
      badProviderApiKey.slice(0, 8),
      JSON.stringify(encryption.encrypt(badProviderApiKey)),
      encryption.keyId,
      randomUUID(),
      goodProviderApiKey.slice(0, 8),
      JSON.stringify(encryption.encrypt(goodProviderApiKey)),
      encryption.keyId,
      randomUUID(),
      fallbackProviderId,
      fallbackProviderApiKey.slice(0, 8),
      JSON.stringify(encryption.encrypt(fallbackProviderApiKey)),
      encryption.keyId,
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
      values ($1, $2, 'primary-model', 'Primary Model', 128000, true, true, 'available'),
             ($3, $4, 'fallback-model', 'Fallback Model', 128000, true, true, 'available')
    `,
    [primaryProviderModelId, primaryProviderId, fallbackProviderModelId, fallbackProviderId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, 'multi-key-coding', 'Multi Key Coding', true)",
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
             ($4, $2, $5, 2, true)
    `,
    [randomUUID(), routePolicyId, primaryProviderModelId, randomUUID(), fallbackProviderModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Multi Key Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      insert into agent_api_keys (
        id,
        agent_id,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, $2, $3, $4, $5, true)
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
      insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Multi key config')",
  );

  return { badProviderApiKeyId, primaryProviderModelId };
}

async function expectFallbackEvents(
  fixture: Fixture,
  expectedRows: FallbackEventRow[],
): Promise<void> {
  const result = await fixture.query<FallbackEventRow>(
    `
      select provider_model_id::text,
             provider_api_key_id::text,
             provider_api_key_prefix,
             attempt_order,
             status,
             error_code,
             failed_before_first_byte
      from fallback_events
      order by attempt_order
    `,
  );
  expect(result.rows).toEqual(expectedRows);
}

async function expectActivity(fixture: Fixture, expected: ActivityRow): Promise<void> {
  await expect
    .poll(async () => {
      const result = await fixture.query<ActivityRow>(
        `
          select request_id,
                 status,
                 provider_model_id::text,
                 fallback_attempts
          from request_activity
          where request_id = $1
        `,
        [expected.request_id],
      );
      return result.rows[0] ?? null;
    })
    .toEqual(expected);
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
