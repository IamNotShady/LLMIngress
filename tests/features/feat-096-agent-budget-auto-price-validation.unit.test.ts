import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeAgentLimitFormInput,
  saveAgentLimitRules,
} from "../../apps/console/src/server/agent-limits";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-096 Agent budget automatic price validation", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("normalizes Agent-scoped limits without manual budget price fields", () => {
    expect(
      normalizeAgentLimitFormInput({
        agentId: " agent-096 ",
        budgetPeriod: " month ",
        budgetUsd: "12.50",
        rpm: "90",
        tokenLimit: "16000",
        tpm: "240000",
      }),
    ).toEqual({
      agentId: "agent-096",
      rules: [
        {
          alertThreshold: null,
          enforcementPolicy: "block",
          limitType: "budget",
          limitValue: 12.5,
          manualBypass: false,
          period: "month",
          unit: "usd",
        },
        {
          alertThreshold: null,
          enforcementPolicy: "block",
          limitType: "rpm",
          limitValue: 90,
          manualBypass: false,
          period: "minute",
          unit: "requests",
        },
        {
          alertThreshold: null,
          enforcementPolicy: "block",
          limitType: "tpm",
          limitValue: 240000,
          manualBypass: false,
          period: "minute",
          unit: "tokens",
        },
        {
          alertThreshold: null,
          enforcementPolicy: "block",
          limitType: "token",
          limitValue: 16000,
          manualBypass: false,
          period: "request",
          unit: "tokens",
        },
      ],
    });
  });

  it("blocks every accessible route candidate with missing effective prices before saving budget limits", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_agent_budget_auto_price_unit_${randomUUID().replaceAll(
        "-",
        "_",
      )}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedAgentBudgetValidationGraph(fixture);
    const limits = normalizeAgentLimitFormInput({
      agentId: seeded.agentApiKeyId,
      budgetPeriod: "month",
      budgetUsd: "12.50",
      rpm: "90",
      tokenLimit: "16000",
      tpm: "240000",
    });

    await expect(
      saveAgentLimitRules({
        databaseUrl: fixture.databaseUrl,
        limits,
      }),
    ).rejects.toThrow(
      /(?=.*Unknown Primary Model)(?=.*Unknown Fallback Model)(?=.*unknown price)(?=.*manual price override)(?=.*sync prices)/i,
    );
    await expect.poll(() => countAgentLimits(fixture, seeded.agentApiKeyId)).toBe(0);
    await expect.poll(() => countAgentLimitConfigChanges(fixture)).toBe(0);

    await fixture.query(
      `
        update provider_models
        set manual_input_usd_per_million_tokens = 1.25,
            manual_output_usd_per_million_tokens = 5.50,
            manual_price_updated_at = now()
        where id = $1
      `,
      [seeded.unknownPrimaryModelId],
    );
    await fixture.query(
      `
        update provider_models
        set synced_input_usd_per_million_tokens = 0.75,
            synced_output_usd_per_million_tokens = 2.25,
            synced_price_source = 'models.dev',
            synced_price_source_url = 'test://prices',
            synced_price_version = 'price-sync:096',
            synced_price_synced_at = now(),
            synced_price_updated_at = now()
        where model_id = 'unknown-fallback-model'
      `,
    );

    await expect(
      saveAgentLimitRules({
        databaseUrl: fixture.databaseUrl,
        limits,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ limitType: "budget", limitValue: 12.5, unit: "usd" }),
        expect.objectContaining({ limitType: "rpm", limitValue: 90, unit: "requests" }),
        expect.objectContaining({ limitType: "tpm", limitValue: 240000, unit: "tokens" }),
        expect.objectContaining({ limitType: "token", limitValue: 16000, unit: "tokens" }),
      ]),
    );
    await expect.poll(() => countAgentLimits(fixture, seeded.agentApiKeyId)).toBe(4);
    await expect.poll(() => countAgentLimitConfigChanges(fixture)).toBe(1);
  });
});

async function seedAgentBudgetValidationGraph(fixture: Fixture): Promise<{
  agentApiKeyId: string;
  unknownPrimaryModelId: string;
}> {
  const providerId = randomUUID();
  const unknownPrimaryModelId = randomUUID();
  const unknownFallbackModelId = randomUUID();
  const builtInModelId = randomUUID();
  const unrelatedUnknownModelId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = agentId;
  const defaultVirtualModelId = randomUUID();
  const allowedVirtualModelId = randomUUID();
  const unrelatedVirtualModelId = randomUUID();
  const defaultRoutePolicyId = randomUUID();
  const allowedRoutePolicyId = randomUUID();
  const unrelatedRoutePolicyId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI Auto Budget Provider', 'https://api.openai.com/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $5, 'unknown-primary-model', 'Unknown Primary Model', 'available'),
             ($2, $5, 'unknown-fallback-model', 'Unknown Fallback Model', 'available'),
             ($3, $5, 'gpt-4.1-mini', 'GPT 4.1 Mini', 'available'),
             ($4, $5, 'unrelated-unknown-model', 'Unrelated Unknown Model', 'available')
    `,
    [
      unknownPrimaryModelId,
      unknownFallbackModelId,
      builtInModelId,
      unrelatedUnknownModelId,
      providerId,
    ],
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = 0.40,
          synced_output_usd_per_million_tokens = 1.60,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'https://models.dev/api.json',
          synced_price_version = 'models.dev:096',
          synced_price_synced_at = now(),
          synced_price_updated_at = now()
      where model_id = 'gpt-4.1-mini'
    `,
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'auto-budget-default', 'Auto Budget Default', true),
             ($2, 'auto-budget-allowed', 'Auto Budget Allowed', true),
             ($3, 'auto-budget-unrelated', 'Auto Budget Unrelated', true)
    `,
    [defaultVirtualModelId, allowedVirtualModelId, unrelatedVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $4, 'fixed'),
             ($2, $5, 'fixed'),
             ($3, $6, 'fixed')
    `,
    [
      defaultRoutePolicyId,
      allowedRoutePolicyId,
      unrelatedRoutePolicyId,
      defaultVirtualModelId,
      allowedVirtualModelId,
      unrelatedVirtualModelId,
    ],
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
      values ($1, $7, $10, 1, false),
             ($2, $7, $12, 2, true),
             ($3, $8, $12, 1, false),
             ($4, $8, $11, 2, true),
             ($5, $9, $13, 1, false),
             ($6, $9, $12, 2, true)
    `,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      defaultRoutePolicyId,
      allowedRoutePolicyId,
      unrelatedRoutePolicyId,
      unknownPrimaryModelId,
      unknownFallbackModelId,
      builtInModelId,
      unrelatedUnknownModelId,
    ],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, enabled)
      values ($1, 'Auto Budget Agent', 'coding', true)
    `,
    [agentId],
  );
  await fixture.query(
    `
      update agents
      set key_prefix = 'llmi_auto96',
          key_hash = 'sha256:v1:auto-budget-096',
          default_virtual_model_id = $2
      where id = $1
    `,
    [agentId, defaultVirtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3)
    `,
    [agentApiKeyId, defaultVirtualModelId, allowedVirtualModelId],
  );

  return { agentApiKeyId, unknownPrimaryModelId };
}

async function countAgentLimits(fixture: Fixture, agentApiKeyId: string): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from agent_limits
      where agent_id = $1
    `,
    [agentApiKeyId],
  );
  return result.rows[0]?.count ?? 0;
}

async function countAgentLimitConfigChanges(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `
      select count(*)::integer as count
      from config_versions
      cross join lateral jsonb_array_elements(config_versions.changes) as change(value)
      where change.value->>'source' = 'console'
        and change.value->>'table' = 'agent_limits'
    `,
  );
  return result.rows[0]?.count ?? 0;
}
