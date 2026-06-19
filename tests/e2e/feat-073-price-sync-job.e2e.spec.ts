import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createPostgresPeriodicScheduler } from "../../apps/worker/src/periodic-scheduler";
import { createPriceSyncJobHandler } from "../../apps/worker/src/price-sync";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("manual and scheduled price sync writes current provider model prices without historical rewrite", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_price_sync_${randomUUID().replaceAll("-", "_")}`,
  });
  const manualJobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedPriceSyncConfig(fixture);

    await expect(readRouteCandidatePrice(fixture)).resolves.toMatchObject({
      reason: "no_current_price",
      status: "unknown_price",
    });
    const historicalCostBefore = await readHistoricalCost(fixture);

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        price_sync: createPriceSyncJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T00:00:00.000Z"),
        }),
      },
      workerId: "price-sync-worker",
    });

    await insertPriceSyncJob(fixture, {
      jobId: manualJobId,
      priceVersion: "price-sync:test-v1",
      prices: [
        {
          cachedInputUsdPerMillionTokens: 0.25,
          inputUsdPerMillionTokens: 1.25,
          modelId: "synced-model",
          outputUsdPerMillionTokens: 2.5,
          providerKey: "synced-provider",
        },
      ],
      sourceUrl: "test://prices/v1",
      trigger: "manual",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, manualJobId)).resolves.toMatchObject({
      result: {
        priceVersion: "price-sync:test-v1",
        snapshotCount: 1,
        trigger: "manual",
      },
      status: "succeeded",
    });
    await expect(readPriceSnapshots(fixture)).resolves.toEqual([
      {
        cached_input_usd_per_million_tokens: "0.25000000",
        input_usd_per_million_tokens: "1.25000000",
        model_id: "synced-model",
        output_usd_per_million_tokens: "2.50000000",
        price_version: "price-sync:test-v1",
        provider_key: "synced-provider",
        source: "models.dev",
        source_url: "test://prices/v1",
      },
    ]);
    await expect(readRouteCandidatePrice(fixture)).resolves.toMatchObject({
      cachedInputUsdPerMillionTokens: 0.25,
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 2.5,
      priceVersion: "price-sync:test-v1",
      source: "price_sync",
      status: "priced",
    });
    await expect(readConfigPublication(fixture)).resolves.toEqual({
      priceRegistryChangeCount: "1",
      workerVersionCount: "1",
    });

    const scheduledJobId = await enqueueScheduledPriceSyncJob(fixture, {
      priceVersion: "price-sync:test-v2",
      prices: [
        {
          cachedInputUsdPerMillionTokens: 0.5,
          inputUsdPerMillionTokens: 2,
          modelId: "synced-model",
          outputUsdPerMillionTokens: 4,
          providerKey: "synced-provider",
        },
      ],
      sourceUrl: "test://prices/v2",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, scheduledJobId)).resolves.toMatchObject({
      result: {
        priceVersion: "price-sync:test-v2",
        snapshotCount: 1,
        trigger: "scheduled",
      },
      status: "succeeded",
    });
    await expect(readPriceSnapshots(fixture)).resolves.toEqual([
      {
        cached_input_usd_per_million_tokens: "0.50000000",
        input_usd_per_million_tokens: "2.00000000",
        model_id: "synced-model",
        output_usd_per_million_tokens: "4.00000000",
        price_version: "price-sync:test-v2",
        provider_key: "synced-provider",
        source: "models.dev",
        source_url: "test://prices/v2",
      },
    ]);
    await expect(readRouteCandidatePrice(fixture)).resolves.toMatchObject({
      cachedInputUsdPerMillionTokens: 0.5,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 4,
      priceVersion: "price-sync:test-v2",
      source: "price_sync",
      status: "priced",
    });
    await expect(readConfigPublication(fixture)).resolves.toEqual({
      priceRegistryChangeCount: "2",
      workerVersionCount: "2",
    });
    await expect(readHistoricalCost(fixture)).resolves.toEqual(historicalCostBefore);
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type PriceSyncJobInput = {
  jobId: string;
  priceVersion: string;
  prices: Array<{
    cachedInputUsdPerMillionTokens?: number;
    inputUsdPerMillionTokens: number;
    modelId: string;
    outputUsdPerMillionTokens: number;
    providerKey: string;
  }>;
  sourceUrl: string;
  trigger: "manual" | "scheduled";
};

type ScheduledPriceSyncJobInput = Omit<PriceSyncJobInput, "jobId" | "trigger">;

type PriceSnapshotRow = {
  cached_input_usd_per_million_tokens: string | null;
  input_usd_per_million_tokens: string;
  model_id: string;
  output_usd_per_million_tokens: string;
  price_version: string;
  provider_key: string;
  source: string;
  source_url: string | null;
};

type HistoricalCostRow = {
  cost_source: string;
  price_source: string | null;
  price_version: string | null;
  total_cost_usd: string | null;
};

async function seedPriceSyncConfig(fixture: Fixture): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const requestActivityId = randomUUID();

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
      values ($1, $2, 'synced-model', 'Synced Model', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'price-sync-coding', 'Price Sync Coding', true)
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
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Price Sync Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_price_073', key_hash = $3, default_virtual_model_id = $4, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, `hash-${randomUUID()}`, virtualModelId],
  );
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
        'req_price_sync_historical_073',
        $2,
        $3,
        $4,
        $5,
        $6,
        'llmi_price_073',
        'chat_completions',
        'price-sync-coding',
        false,
        'succeeded',
        now()
      )
    `,
    [requestActivityId, agentApiKeyId, virtualModelId, routePolicyId, providerId, providerModelId],
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
        'historical-price-version'
      )
    `,
    [randomUUID(), requestActivityId, agentApiKeyId, providerModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Price sync config')",
  );
}

async function insertPriceSyncJob(fixture: Fixture, input: PriceSyncJobInput): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'price_sync', 'pending', $2, $3::jsonb, 1)
    `,
    [
      input.jobId,
      input.trigger,
      JSON.stringify({
        priceVersion: input.priceVersion,
        prices: input.prices,
        sourceUrl: input.sourceUrl,
      }),
    ],
  );
}

async function enqueueScheduledPriceSyncJob(
  fixture: Fixture,
  input: ScheduledPriceSyncJobInput,
): Promise<string> {
  const scheduler = createPostgresPeriodicScheduler({
    databaseUrl: fixture.databaseUrl,
    now: () => new Date("2000-01-01T00:00:00.000Z"),
    tasks: [
      {
        id: "price-sync-test",
        intervalMs: 60_000,
        jobType: "price_sync",
        maxAttempts: 1,
        payload: {
          priceVersion: input.priceVersion,
          prices: input.prices,
          sourceUrl: input.sourceUrl,
        },
        priority: 0,
        startAt: new Date("2000-01-01T00:00:00.000Z"),
      },
    ],
  });

  await expect(scheduler.runOnce()).resolves.toEqual({
    createdJobs: 1,
    deduplicatedJobs: 0,
    skippedTasks: 0,
  });

  const result = await fixture.query<{ id: string }>(
    `
      select id::text
      from jobs
      where job_type = 'price_sync'
        and trigger = 'scheduled'
        and status = 'pending'
      order by created_at desc
      limit 1
    `,
  );
  const jobId = result.rows[0]?.id;
  if (!jobId) {
    throw new Error("Scheduled price sync job was not created.");
  }
  return jobId;
}

async function readRouteCandidatePrice(fixture: Fixture) {
  const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
  return snapshot.routePolicies[0]?.candidates[0]?.price;
}

async function readPriceSnapshots(fixture: Fixture): Promise<PriceSnapshotRow[]> {
  const result = await fixture.query<PriceSnapshotRow>(
    `
      select provider_key,
             model_id,
             input_usd_per_million_tokens::text,
             cached_input_usd_per_million_tokens::text,
             output_usd_per_million_tokens::text,
             source,
             source_url,
             price_version
      from provider_models_price
      order by provider_key, model_id, source
    `,
  );
  return result.rows;
}

async function readHistoricalCost(fixture: Fixture): Promise<HistoricalCostRow | null> {
  const result = await fixture.query<HistoricalCostRow>(
    `
      select request_costs.total_cost_usd::text,
             request_costs.cost_source,
             request_costs.price_source,
             request_costs.price_version
      from request_costs
      join request_activity on request_activity.id = request_costs.request_activity_id
      where request_activity.request_id = 'req_price_sync_historical_073'
    `,
  );
  return result.rows[0] ?? null;
}

async function readConfigPublication(fixture: Fixture): Promise<{
  priceRegistryChangeCount: string;
  workerVersionCount: string;
}> {
  const result = await fixture.query<{
    price_registry_change_count: string;
    worker_version_count: string;
  }>(
    `
      select (
               select count(*)::text
               from config_change_events
               where source = 'worker'
                 and changed_table = 'provider_models_price'
             ) as price_registry_change_count,
             (
               select count(*)::text
               from config_versions
               where source = 'worker'
             ) as worker_version_count
    `,
  );
  const row = result.rows[0];
  return {
    priceRegistryChangeCount: row?.price_registry_change_count ?? "0",
    workerVersionCount: row?.worker_version_count ?? "0",
  };
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
