import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  getVirtualModelDeleteDependencyError,
  listVirtualModels,
  normalizeVirtualModelFormInput,
} from "../../apps/console/src/server/virtual-models";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-028 virtual model CRUD", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("normalizes virtual model form input for persistence", () => {
    expect(
      normalizeVirtualModelFormInput({
        description: " Coding Fast ",
        name: " Coding Fast ",
      }),
    ).toEqual({
      description: "Coding Fast",
      name: "coding-fast",
    });
  });

  it("rejects empty names and invalid virtual model names", () => {
    expect(() =>
      normalizeVirtualModelFormInput({
        description: "Coding Fast",
        name: "",
      }),
    ).toThrow(/virtual model name/i);

    expect(() =>
      normalizeVirtualModelFormInput({
        description: "Coding Fast",
        name: "bad/name",
      }),
    ).toThrow(/lowercase letters/i);
  });

  it("reports dependency errors before deleting referenced virtual models", () => {
    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 0,
        routePolicyCount: 1,
      }),
    ).toMatch(/route/i);

    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 1,
        defaultAgentCount: 0,
        routePolicyCount: 0,
      }),
    ).toMatch(/agent/i);

    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 0,
        routePolicyCount: 0,
      }),
    ).toBeNull();
  });

  it("lists real usage metrics and keeps unused virtual models at zero", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_virtual_model_metrics_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedVirtualModelMetrics(fixture);

    const virtualModels = await listVirtualModels(fixture.databaseUrl);

    expect(selectMetricFields(virtualModels.find((model) => model.name === "mix-unused"))).toEqual({
      cost24hUsd: "0.00000000",
      failureCountTotal: 0,
      requestCountTotal: 0,
      requestCount24h: 0,
    });
    expect(
      selectMetricFields(virtualModels.find((model) => model.name === "used-balanced")),
    ).toEqual({
      cost24hUsd: "0.04000000",
      failureCountTotal: 2,
      requestCountTotal: 3,
      requestCount24h: 2,
    });
  });
});

async function seedVirtualModelMetrics(fixture: Fixture): Promise<void> {
  const agentId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const unusedVirtualModelId = randomUUID();
  const usedVirtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const succeededActivityId = randomUUID();
  const failedActivityId = randomUUID();
  const oldFailedActivityId = randomUUID();

  await fixture.query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openai', 'OpenAI', true)",
    [providerId],
  );
  await fixture.query(
    "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, 'gpt-4.1-mini', 'GPT-4.1 Mini')",
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'mix-unused', 'Mix Unused', true),
             ($2, 'used-balanced', 'Used Balanced', true)
    `,
    [unusedVirtualModelId, usedVirtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'random')",
    [routePolicyId, usedVirtualModelId],
  );
  await fixture.query(
    `insert into agents
       (id, name, agent_type, key_prefix, key_hash, default_virtual_model_id, enabled)
     values ($1, 'Metric Agent', 'coding', 'metric001', 'sha256:v1:metric', $2, true)`,
    [agentId, usedVirtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity
        (id, request_id, agent_id, virtual_model_id, route_policy_id, provider_id,
         provider_model_id, agent_key_prefix, protocol, model, status, http_status, started_at)
      values
        ($1, 'req_vm_unit_success', $2, $3, $4, $5, $6, 'metric001',
         'chat_completions', 'used-balanced', 'succeeded', 200, now()),
        ($7, 'req_vm_unit_failure', $2, $3, $4, $5, $6, 'metric001',
         'chat_completions', 'used-balanced', 'failed', 502, now()),
        ($8, 'req_vm_unit_old_failure', $2, $3, $4, $5, $6, 'metric001',
         'chat_completions', 'used-balanced', 'failed', 502, now() - interval '2 days')
    `,
    [
      succeededActivityId,
      agentId,
      usedVirtualModelId,
      routePolicyId,
      providerId,
      providerModelId,
      failedActivityId,
      oldFailedActivityId,
    ],
  );
  await fixture.query(
    `
      insert into request_costs
        (id, request_activity_id, agent_id, provider_model_id, total_cost_usd, cost_source)
      values ($1, $2, $3, $4, 0.01, 'provider'),
             ($5, $6, $3, $4, 0.03, 'provider')
    `,
    [randomUUID(), succeededActivityId, agentId, providerModelId, randomUUID(), failedActivityId],
  );
}

function selectMetricFields(
  model:
    | {
        cost24hUsd: string | null;
        failureCountTotal: number;
        requestCountTotal: number;
        requestCount24h: number;
      }
    | undefined,
) {
  if (!model) {
    throw new Error("Virtual model was not found.");
  }
  return {
    cost24hUsd: model.cost24hUsd,
    failureCountTotal: model.failureCountTotal,
    requestCountTotal: model.requestCountTotal,
    requestCount24h: model.requestCount24h,
  };
}
