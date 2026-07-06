import { randomUUID } from "node:crypto";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";

const masterKey = "test-master-key";
const agentApiKey = "llmi_gateway_pool_test_key_094";

test("gateway serves a 30-request burst with bounded postgres connections", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_pool_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedPoolRoute(fixture, fakeProvider.url);
    await slowRequestActivityInserts(fixture);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { LLMINGRESS_DB_POOL_MAX: "10" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const requests = Array.from({ length: 30 }, () =>
        fetch(`${baseUrl}/v1/chat/completions`, {
          body: JSON.stringify({
            messages: [{ content: "ping", role: "user" }],
            model: "vm-pool",
          }),
          headers: {
            authorization: `Bearer ${agentApiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      const peakConnections = await readPeakConnectionCountWhilePending(fixture, requests);
      const responses = await Promise.all(requests);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }
      expect(peakConnections).toBeLessThanOrEqual(16);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

async function seedPoolRoute(fixture: Fixture, providerBaseUrl: string): Promise<void> {
  const agentId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    "fake-provider-key",
  );

  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        key_prefix,
        key_hash,
        enabled
      )
      values ($1, 'Pool Test Agent', 'coding', $2, $3, true)
    `,
    [agentId, agentApiKey.slice(0, 12), buildGatewayAgentApiKeyHash(agentApiKey)],
  );
  await fixture.query(
    `
      insert into providers (
        id,
        provider_type,
        provider_key,
        provider_template_id,
        display_name,
        base_url,
        enabled
      )
      values ($1, 'api_key', 'openai', null, 'OpenAI', $2, true)
    `,
    [providerId, providerBaseUrl],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, 'fake-provide', $3, $4)
    `,
    [randomUUID(), providerId, JSON.stringify(encrypted), encrypted.keyId],
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
      values ($1, $2, 'fake-model', 'Fake Model', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'vm-pool', 'VM Pool', true)",
    [virtualModelId],
  );
  await fixture.query("update agents set default_virtual_model_id = $2 where id = $1", [
    agentId,
    virtualModelId,
  ]);
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
    [agentId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Gateway pool test config')",
  );
}

async function slowRequestActivityInserts(fixture: Fixture): Promise<void> {
  await fixture.query(`
    create or replace function pool_test_sleep_request_activity()
    returns trigger language plpgsql as $$
    begin
      perform pg_sleep(0.2);
      return new;
    end;
    $$;
  `);
  await fixture.query(`
    create trigger pool_test_sleep_request_activity
    before insert on request_activity
    for each row execute function pool_test_sleep_request_activity();
  `);
}

async function readPeakConnectionCountWhilePending(
  fixture: Fixture,
  requests: Promise<Response>[],
): Promise<number> {
  let peak = 0;
  let settled = false;
  void Promise.allSettled(requests).then(() => {
    settled = true;
  });

  while (!settled) {
    const result = await fixture.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database()",
    );
    peak = Math.max(peak, result.rows[0]?.n ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return peak;
}
