import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createPriceSyncJobHandler } from "../../apps/worker/src/price-sync";
import { loadGatewayConfigSnapshot } from "../../packages/db/src/gateway-config-reload";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("provider model synced prices live on provider_models without provider_models_price", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_price_merge_${randomUUID().replaceAll("-", "_")}`,
  });
  const jobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedRouteCandidate(fixture);

    await expect(readDroppedPriceTable(fixture)).resolves.toBe(null);
    await expect(readRouteCandidatePrice(fixture)).resolves.toMatchObject({
      reason: "no_current_price",
      status: "unknown_price",
    });

    await fixture.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'price_sync', 'pending', 'manual', $2::jsonb, 1)
      `,
      [
        jobId,
        JSON.stringify({
          priceVersion: "price-sync:provider-models-v1",
          prices: [
            {
              cachedInputUsdPerMillionTokens: 0.25,
              inputUsdPerMillionTokens: 1.25,
              modelId: "synced-model",
              outputUsdPerMillionTokens: 2.5,
              providerKey: "synced-provider",
            },
          ],
          sourceUrl: "test://provider-model-price-merge",
        }),
      ],
    );

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        price_sync: createPriceSyncJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-20T00:00:00.000Z"),
        }),
      },
      workerId: "price-merge-worker",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, jobId)).resolves.toMatchObject({
      result: {
        priceVersion: "price-sync:provider-models-v1",
        syncedPriceCount: 1,
        trigger: "manual",
      },
      status: "succeeded",
    });
    await expect(readProviderModelSyncedPrice(fixture)).resolves.toEqual({
      synced_cached_input_usd_per_million_tokens: "0.25000000",
      synced_input_usd_per_million_tokens: "1.25000000",
      synced_output_usd_per_million_tokens: "2.50000000",
      synced_price_source: "models.dev",
      synced_price_source_url: "test://provider-model-price-merge",
      synced_price_version: "price-sync:provider-models-v1",
    });
    await expect(readRouteCandidatePrice(fixture)).resolves.toMatchObject({
      cachedInputUsdPerMillionTokens: 0.25,
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 2.5,
      priceVersion: "price-sync:provider-models-v1",
      source: "price_sync",
      status: "priced",
    });
    await expect(readConfigPublication(fixture)).resolves.toEqual({
      providerModelsChangeCount: "1",
      workerVersionCount: "1",
    });
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

async function seedRouteCandidate(fixture: Fixture): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

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
        availability
      )
      values ($1, $2, 'synced-model', 'Synced Model', 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'price-merge-coding', 'Price Merge Coding', true)",
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
    "insert into config_versions (version, source, description) values (1, 'console', 'Price merge config')",
  );
}

async function readDroppedPriceTable(fixture: Fixture): Promise<string | null> {
  const result = await fixture.query<{ table_name: string | null }>(
    "select to_regclass('public.provider_models_price')::text as table_name",
  );
  return result.rows[0]?.table_name ?? null;
}

async function readRouteCandidatePrice(fixture: Fixture) {
  const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
  return snapshot.routePolicies[0]?.candidates[0]?.price;
}

async function readProviderModelSyncedPrice(fixture: Fixture): Promise<{
  synced_cached_input_usd_per_million_tokens: string | null;
  synced_input_usd_per_million_tokens: string | null;
  synced_output_usd_per_million_tokens: string | null;
  synced_price_source: string | null;
  synced_price_source_url: string | null;
  synced_price_version: string | null;
} | null> {
  const result = await fixture.query<{
    synced_cached_input_usd_per_million_tokens: string | null;
    synced_input_usd_per_million_tokens: string | null;
    synced_output_usd_per_million_tokens: string | null;
    synced_price_source: string | null;
    synced_price_source_url: string | null;
    synced_price_version: string | null;
  }>(
    `
      select synced_input_usd_per_million_tokens::text,
             synced_cached_input_usd_per_million_tokens::text,
             synced_output_usd_per_million_tokens::text,
             synced_price_source,
             synced_price_source_url,
             synced_price_version
      from provider_models
      where model_id = 'synced-model'
    `,
  );
  return result.rows[0] ?? null;
}

async function readConfigPublication(fixture: Fixture): Promise<{
  providerModelsChangeCount: string;
  workerVersionCount: string;
}> {
  const result = await fixture.query<{
    provider_models_change_count: string;
    worker_version_count: string;
  }>(
    `
      select (
               select count(*)::text
               from config_versions
               cross join lateral jsonb_array_elements(config_versions.changes) as change(value)
               where change.value->>'source' = 'worker'
                 and change.value->>'table' = 'provider_models'
             ) as provider_models_change_count,
             (
               select count(*)::text
               from config_versions
               where source = 'worker'
             ) as worker_version_count
    `,
  );
  const row = result.rows[0];
  return {
    providerModelsChangeCount: row?.provider_models_change_count ?? "0",
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
