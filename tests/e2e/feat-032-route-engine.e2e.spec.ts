import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { selectRouteCandidate } from "../../apps/gateway/src/route-engine";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("fixed routing and cost first routing are deterministic with route reason", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_route_engine_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRouteEngineConfig(fixture);

    const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
    expect(snapshot.version).toBe(1);

    const fixedDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "fixed-coding",
    });
    const repeatedFixedDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "fixed-coding",
    });

    expect(fixedDecision).toEqual(repeatedFixedDecision);
    expect(fixedDecision).toMatchObject({
      modelId: "gpt-4.1",
      providerModelId: seeded.fixedModelId,
      routeReason: {
        selectedCandidateOrder: 1,
        strategy: "fixed",
      },
    });
    expect(fixedDecision.routeReason.message).toContain("fixed route");

    const costDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "cost-coding",
    });
    const repeatedCostDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "cost-coding",
    });

    expect(costDecision).toEqual(repeatedCostDecision);
    expect(costDecision).toMatchObject({
      modelId: "custom-low-cost",
      providerModelId: seeded.manualPricedModelId,
      routeReason: {
        estimatedCostUsd: 0.03,
        priceSource: "manual_override",
        selectedCandidateOrder: 2,
        strategy: "cost_first",
      },
    });
    expect(costDecision.routeReason.message).toContain("cheapest eligible candidate");
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type SeededRouteEngineConfig = {
  fixedModelId: string;
  manualPricedModelId: string;
};

async function seedRouteEngineConfig(fixture: Fixture): Promise<SeededRouteEngineConfig> {
  const openaiProviderId = randomUUID();
  const customProviderId = randomUUID();
  const fixedModelId = randomUUID();
  const cheapModelId = randomUUID();
  const manualPricedModelId = randomUUID();
  const unknownModelId = randomUUID();
  const fixedVirtualModelId = randomUUID();
  const costVirtualModelId = randomUUID();
  const fixedRoutePolicyId = randomUUID();
  const costRoutePolicyId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', 'https://api.openai.com/v1', true),
             ($2, 'api_key', 'custom-ai', 'Custom AI', 'https://custom.example/v1', true)
    `,
    [openaiProviderId, customProviderId],
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
             ($3, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 128000, true, true, 'available'),
             ($4, $5, 'custom-low-cost', 'Custom Low Cost', 128000, true, true, 'available'),
             ($6, $5, 'custom-unpriced', 'Custom Unpriced', 128000, true, true, 'available')
    `,
    [
      fixedModelId,
      openaiProviderId,
      cheapModelId,
      manualPricedModelId,
      customProviderId,
      unknownModelId,
    ],
  );
  await fixture.query(
    `
      update provider_models
      set manual_input_usd_per_million_tokens = 0.01,
          manual_output_usd_per_million_tokens = 0.02,
          manual_price_updated_at = now()
      where id = $1
    `,
    [manualPricedModelId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'fixed-coding', 'Fixed Coding', true),
             ($2, 'cost-coding', 'Cost Coding', true)
    `,
    [fixedVirtualModelId, costVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed'),
             ($3, $4, 'cost_first')
    `,
    [fixedRoutePolicyId, fixedVirtualModelId, costRoutePolicyId, costVirtualModelId],
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
             ($4, $2, $5, 2, false),
             ($6, $7, $3, 1, false),
             ($8, $7, $9, 2, false),
             ($10, $7, $11, 3, false),
             ($12, $7, $5, 4, true)
    `,
    [
      randomUUID(),
      fixedRoutePolicyId,
      fixedModelId,
      randomUUID(),
      cheapModelId,
      randomUUID(),
      costRoutePolicyId,
      randomUUID(),
      manualPricedModelId,
      randomUUID(),
      unknownModelId,
      randomUUID(),
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Route engine E2E config')",
  );

  return {
    fixedModelId,
    manualPricedModelId,
  };
}
