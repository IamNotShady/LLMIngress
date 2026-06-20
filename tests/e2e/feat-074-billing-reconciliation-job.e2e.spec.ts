import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createBillingReconciliationJobHandler } from "../../apps/worker/src/billing-reconciliation";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("billing reconciliation updates request costs without audit tables", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_billing_reconciliation_${randomUUID().replaceAll("-", "_")}`,
  });
  const jobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seed = await seedBillingReconciliationData(fixture);
    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        billing_reconciliation: createBillingReconciliationJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T04:00:00.000Z"),
        }),
      },
      workerId: "billing-reconciliation-worker",
    });

    await insertBillingReconciliationJob(fixture, {
      jobId,
      providerCosts: [
        {
          inputCostUsd: 0.0007,
          outputCostUsd: 0.0009,
          priceSource: "provider_billing",
          priceVersion: "provider-bill:2026-06-16",
          requestId: "req_provider_reconcile_074",
          totalCostUsd: 0.0016,
        },
      ],
      requestIds: ["req_price_reconcile_074", "req_provider_reconcile_074"],
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    const jobResult = await readJobResult(fixture, jobId);
    expect(jobResult).toMatchObject({
      result: {
        scannedRequestCount: 2,
        skippedRequestCount: 0,
        updatedRequestCount: 2,
      },
      status: "succeeded",
    });
    expect(jobResult.result).not.toHaveProperty("runId");
    await expect(readBillingReconciliationAuditTables(fixture)).resolves.toEqual({
      items: null,
      runs: null,
    });
    await expect(readCostsAndSavings(fixture)).resolves.toEqual([
      {
        actual_cost_usd: "0.00340000",
        cost_source: "reconciled",
        input_cost_usd: "0.00140000",
        output_cost_usd: "0.00200000",
        price_source: "price_sync",
        price_version: "price-sync:reconcile-v1",
        provider_model_id: seed.priceProviderModelId,
        request_id: "req_price_reconcile_074",
        savings_usd: "0.00660000",
        total_cost_usd: "0.00340000",
      },
      {
        actual_cost_usd: "0.00160000",
        cost_source: "provider",
        input_cost_usd: "0.00070000",
        output_cost_usd: "0.00090000",
        price_source: "provider_billing",
        price_version: "provider-bill:2026-06-16",
        provider_model_id: seed.providerActualProviderModelId,
        request_id: "req_provider_reconcile_074",
        savings_usd: "0.00840000",
        total_cost_usd: "0.00160000",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type BillingReconciliationJobInput = {
  jobId: string;
  providerCosts: Array<{
    inputCostUsd: number;
    outputCostUsd: number;
    priceSource: string;
    priceVersion: string;
    requestId: string;
    totalCostUsd: number;
  }>;
  requestIds: string[];
};

type SeededBillingReconciliationData = {
  priceProviderModelId: string;
  providerActualProviderModelId: string;
};

type CostAndSavingsRow = {
  actual_cost_usd: string | null;
  cost_source: string;
  input_cost_usd: string | null;
  output_cost_usd: string | null;
  price_source: string | null;
  price_version: string | null;
  provider_model_id: string | null;
  request_id: string;
  savings_usd: string | null;
  total_cost_usd: string | null;
};

async function seedBillingReconciliationData(
  fixture: Fixture,
): Promise<SeededBillingReconciliationData> {
  const agentApiKeyId = randomUUID();
  const agentId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const providerId = randomUUID();
  const priceProviderModelId = randomUUID();
  const providerActualProviderModelId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'synced-provider', 'Synced Provider', 'https://provider.example/v1', true)
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
      values ($1, $2, 'synced-model', 'Synced Model', 128000, true, true, 'available'),
             ($3, $2, 'provider-actual-model', 'Provider Actual Model', 128000, true, true, 'available')
    `,
    [priceProviderModelId, providerId, providerActualProviderModelId],
  );
  await fixture.query(
    `
      update provider_models
      set synced_input_usd_per_million_tokens = 2,
          synced_cached_input_usd_per_million_tokens = 0.5,
          synced_output_usd_per_million_tokens = 4,
          synced_price_source = 'models.dev',
          synced_price_source_url = 'test://prices/reconcile',
          synced_price_version = 'price-sync:reconcile-v1',
          synced_price_synced_at = '2026-06-16T00:00:00.000Z',
          synced_price_updated_at = '2026-06-16T00:00:00.000Z'
      where model_id = 'synced-model'
    `,
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'billing-reconcile-coding', 'Billing Reconcile Coding', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed')
    `,
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Billing Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_bill_074', key_hash = $3, default_virtual_model_id = $4, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, `hash-${randomUUID()}`, virtualModelId],
  );

  await seedCompletedRequest(fixture, {
    agentApiKeyId,
    baselineCostUsd: 0.01,
    providerId,
    providerModelId: priceProviderModelId,
    requestId: "req_price_reconcile_074",
    routePolicyId,
    usage: {
      cachedInputTokens: 400,
      inputTokens: 1_000,
      outputTokens: 500,
    },
    virtualModelId,
  });
  await seedCompletedRequest(fixture, {
    agentApiKeyId,
    baselineCostUsd: 0.01,
    providerId,
    providerModelId: providerActualProviderModelId,
    requestId: "req_provider_reconcile_074",
    routePolicyId,
    usage: {
      cachedInputTokens: 0,
      inputTokens: 100,
      outputTokens: 200,
    },
    virtualModelId,
  });

  return {
    priceProviderModelId,
    providerActualProviderModelId,
  };
}

async function seedCompletedRequest(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    baselineCostUsd: number;
    providerId: string;
    providerModelId: string;
    requestId: string;
    routePolicyId: string;
    usage: {
      cachedInputTokens: number;
      inputTokens: number;
      outputTokens: number;
    };
    virtualModelId: string;
  },
): Promise<void> {
  const requestActivityId = randomUUID();
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        route_policy_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        status,
        completed_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        'llmi_bill_074',
        'chat_completions',
        'billing-reconcile-coding',
        false,
        'succeeded',
        now()
      )
    `,
    [
      requestActivityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.routePolicyId,
      input.providerId,
      input.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_usage (
        id,
        request_activity_id,
        agent_id,
        virtual_model_id,
        provider_model_id,
        input_tokens,
        output_tokens,
        total_tokens,
        cached_input_tokens,
        reasoning_tokens,
        token_source
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'provider')
    `,
    [
      randomUUID(),
      requestActivityId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerModelId,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.inputTokens + input.usage.outputTokens,
      input.usage.cachedInputTokens,
    ],
  );
  await fixture.query(
    `
      insert into request_costs (
        id,
        request_activity_id,
        agent_id,
        provider_model_id,
        input_cost_usd,
        output_cost_usd,
        total_cost_usd,
        cost_source,
        price_source,
        price_version
      )
      values (
        $1,
        $2,
        $3,
        $4,
        0.00010000,
        0.00020000,
        0.00030000,
        'estimated',
        'built_in_static_snapshot',
        'stale-price-version'
      )
    `,
    [randomUUID(), requestActivityId, input.agentApiKeyId, input.providerModelId],
  );
  await fixture.query(
    `
      insert into request_savings (
        id,
        request_activity_id,
        baseline_provider_model_id,
        actual_cost_usd,
        baseline_cost_usd,
        savings_usd,
        savings_percent,
        price_source,
        price_version
      )
      values (
        $1,
        $2,
        $3,
        0.00030000,
        $4,
        $5,
        97.000000,
        'built_in_static_snapshot',
        'stale-price-version'
      )
    `,
    [
      randomUUID(),
      requestActivityId,
      input.providerModelId,
      input.baselineCostUsd,
      input.baselineCostUsd - 0.0003,
    ],
  );
}

async function insertBillingReconciliationJob(
  fixture: Fixture,
  input: BillingReconciliationJobInput,
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'billing_reconciliation', 'pending', 'manual', $2::jsonb, 1)
    `,
    [
      input.jobId,
      JSON.stringify({
        providerCosts: input.providerCosts,
        requestIds: input.requestIds,
      }),
    ],
  );
}

async function readJobResult(
  fixture: Fixture,
  jobId: string,
): Promise<{
  result: unknown;
  status: string | null;
}> {
  const result = await fixture.query<{ result: unknown; status: string }>(
    "select status, result from jobs where id = $1",
    [jobId],
  );
  return {
    result: result.rows[0]?.result ?? null,
    status: result.rows[0]?.status ?? null,
  };
}

async function readBillingReconciliationAuditTables(
  fixture: Fixture,
): Promise<{ items: string | null; runs: string | null }> {
  const result = await fixture.query<{ items: string | null; runs: string | null }>(
    `
      select to_regclass('public.billing_reconciliation_runs')::text as runs,
             to_regclass('public.billing_reconciliation_items')::text as items
    `,
  );
  return result.rows[0] ?? { items: null, runs: null };
}

async function readCostsAndSavings(fixture: Fixture): Promise<CostAndSavingsRow[]> {
  const result = await fixture.query<CostAndSavingsRow>(
    `
      select request_activity.request_id,
             request_activity.provider_model_id::text,
             request_costs.input_cost_usd::text,
             request_costs.output_cost_usd::text,
             request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.price_source,
             request_costs.price_version,
             request_savings.actual_cost_usd::text,
             request_savings.savings_usd::text
      from request_activity
      join request_costs on request_costs.request_activity_id = request_activity.id
      join request_savings on request_savings.request_activity_id = request_activity.id
      where request_activity.request_id in (
        'req_price_reconcile_074',
        'req_provider_reconcile_074'
      )
      order by request_activity.request_id
    `,
  );
  return result.rows;
}
