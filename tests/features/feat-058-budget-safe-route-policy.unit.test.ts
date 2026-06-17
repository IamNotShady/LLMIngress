import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRoutePolicy,
  normalizeRoutePolicyFormInput,
} from "../../apps/console/src/server/route-policies";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-058 budget-safe route policy validation", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("blocks unknown-price candidates when a cost-budgeted Agent API key can use the Virtual Model", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_budget_safe_route_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedBudgetedVirtualModelWithUnknownCandidate(fixture);

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          primaryProviderModelIds: [seeded.providerModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).rejects.toThrow(
      /Unknown Budget Model.*unknown price.*manual price override.*priced replacement/i,
    );
    await expect.poll(() => countRoutePolicies(fixture)).toBe(0);

    await fixture.query(
      `
        update provider_models
        set manual_input_usd_per_million_tokens = 1.25,
            manual_output_usd_per_million_tokens = 5.50,
            manual_price_updated_at = now()
        where id = $1
      `,
      [seeded.providerModelId],
    );

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          primaryProviderModelIds: [seeded.providerModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).resolves.toMatchObject({
      primaryCandidates: [
        {
          modelId: "unknown-budget-model",
          priceStatusLabel: "Priced (manual override)",
        },
      ],
    });
  });
});

async function seedBudgetedVirtualModelWithUnknownCandidate(fixture: Fixture): Promise<{
  providerModelId: string;
  virtualModelId: string;
}> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const virtualModelId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Budget Safe Provider', 'https://api.openai.com/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'unknown-budget-model', 'Unknown Budget Model', 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'budget-safe-vm', 'Budget Safe VM', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, enabled)
      values ($1, 'Budget Agent', 'coding', true)
    `,
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
      values ($1, $2, 'llmi_budget', 'sha256:v1:budget-safe', $3, true)
    `,
    [agentApiKeyId, agentId, virtualModelId],
  );
  await fixture.query(
    "insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id) values ($1, $2)",
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_limits (id, agent_api_key_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'budget', 'month', 10, 'usd', true)
    `,
    [randomUUID(), agentApiKeyId],
  );

  return { providerModelId, virtualModelId };
}

async function countRoutePolicies(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from route_policies",
  );
  return result.rows[0]?.count ?? 0;
}
