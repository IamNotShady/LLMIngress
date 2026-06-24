import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createModelRefreshJobHandler } from "../../apps/worker/src/model-refresh";
import { createPriceSyncJobHandler } from "../../apps/worker/src/price-sync";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { enqueueProviderModelRefreshJob } from "../../packages/db/src/provider-jobs";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKeySource = { kind: "inline" as const, value: "test-master-key" };
const syncedAt = new Date("2026-06-17T00:00:00.000Z");

test("refresh models syncs provider model prices with manual override precedence", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_model_price_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer({
    models: [
      { id: "manual-priced-model", name: "Manual Priced Model" },
      { id: "sync-priced-model", name: "Sync Priced Model" },
      { id: "litellm-priced-model", name: "LiteLLM Priced Model" },
      { id: "unknown-price-model", name: "Unknown Price Model" },
    ],
  });
  const providerId = randomUUID();
  const priceSource = async () => [
    {
      cachedInputUsdPerMillionTokens: 0.4,
      inputUsdPerMillionTokens: 1,
      modelId: "manual-priced-model",
      outputUsdPerMillionTokens: 3,
      priceVersion: "models.dev:2026-06-17T00:00:00.000Z",
      providerKey: "openai",
      source: "models.dev" as const,
      sourceUrl: "https://models.dev/api.json",
      syncedAt,
    },
    {
      cachedInputUsdPerMillionTokens: 0.5,
      inputUsdPerMillionTokens: 1.25,
      modelId: "sync-priced-model",
      outputUsdPerMillionTokens: 4,
      priceVersion: "models.dev:2026-06-17T00:00:00.000Z",
      providerKey: "openai",
      source: "models.dev" as const,
      sourceUrl: "https://models.dev/api.json",
      syncedAt,
    },
    {
      cachedInputUsdPerMillionTokens: null,
      inputUsdPerMillionTokens: 0.75,
      modelId: "litellm-priced-model",
      outputUsdPerMillionTokens: 1.5,
      priceVersion: "litellm:2026-06-17T00:00:00.000Z",
      providerKey: "openai",
      source: "litellm" as const,
      sourceUrl:
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      syncedAt,
    },
    {
      cachedInputUsdPerMillionTokens: null,
      inputUsdPerMillionTokens: 2,
      modelId: "claude-side-model",
      outputUsdPerMillionTokens: 10,
      priceVersion: "models.dev:2026-06-17T00:00:00.000Z",
      providerKey: "anthropic",
      source: "models.dev" as const,
      sourceUrl: "https://models.dev/api.json",
      syncedAt,
    },
  ];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${provider.url}/v1`,
      id: providerId,
      providerKey: "openai",
    });
    await insertProviderApiKey(fixture, providerId);

    const modelRefreshRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        model_refresh: createModelRefreshJobHandler({
          databaseUrl: fixture.databaseUrl,
          masterKeySource,
          modelPriceSource: priceSource,
          modelRegistrySource: async () => [],
        }),
      },
      workerId: `worker-model-refresh-price-source-${randomUUID()}`,
    });
    const queuedRefresh = await enqueueProviderModelRefreshJob({
      databaseUrl: fixture.databaseUrl,
      providerId,
    });

    await expect(modelRefreshRunner.runOnce()).resolves.toBe(true);
    const chainedPriceSyncJobId = await readChainedPriceSyncJobId(fixture, queuedRefresh.id);
    await expect(readProviderModelIds(fixture)).resolves.toEqual([
      "litellm-priced-model",
      "manual-priced-model",
      "sync-priced-model",
    ]);

    await setManualProviderModelPrice(fixture, {
      cachedInputUsdPerMillionTokens: 9,
      inputUsdPerMillionTokens: 10,
      modelId: "manual-priced-model",
      outputUsdPerMillionTokens: 20,
      providerId,
    });
    const routeSeed = await seedRoutePolicyForProviderModels(fixture, providerId, [
      "manual-priced-model",
      "sync-priced-model",
      "litellm-priced-model",
    ]);

    const priceSyncRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        price_sync: createPriceSyncJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => syncedAt,
          priceSource,
        } satisfies PriceSyncOptions),
      },
      workerId: `worker-price-source-sync-${randomUUID()}`,
    });

    await expect(priceSyncRunner.runOnce()).resolves.toBe(true);

    await expect(readJobResult(fixture, chainedPriceSyncJobId)).resolves.toMatchObject({
      result: {
        syncedPriceCount: 3,
        trigger: "system",
      },
      status: "succeeded",
    });
    await expect(readProviderModelPriceRows(fixture)).resolves.toEqual([
      {
        cached_input_usd_per_million_tokens: null,
        input_usd_per_million_tokens: "0.75000000",
        model_id: "litellm-priced-model",
        output_usd_per_million_tokens: "1.50000000",
        price_version: "litellm:2026-06-17T00:00:00.000Z",
        provider_key: "openai",
        source: "litellm",
        source_url:
          "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      },
      {
        cached_input_usd_per_million_tokens: "0.40000000",
        input_usd_per_million_tokens: "1.00000000",
        model_id: "manual-priced-model",
        output_usd_per_million_tokens: "3.00000000",
        price_version: "models.dev:2026-06-17T00:00:00.000Z",
        provider_key: "openai",
        source: "models.dev",
        source_url: "https://models.dev/api.json",
      },
      {
        cached_input_usd_per_million_tokens: "0.50000000",
        input_usd_per_million_tokens: "1.25000000",
        model_id: "sync-priced-model",
        output_usd_per_million_tokens: "4.00000000",
        price_version: "models.dev:2026-06-17T00:00:00.000Z",
        provider_key: "openai",
        source: "models.dev",
        source_url: "https://models.dev/api.json",
      },
    ]);
    await expect(readRouteCandidatePrices(fixture, routeSeed.routePolicyId)).resolves.toEqual([
      {
        cachedInputUsdPerMillionTokens: 9,
        inputUsdPerMillionTokens: 10,
        modelId: "manual-priced-model",
        outputUsdPerMillionTokens: 20,
        source: "manual_override",
        status: "priced",
      },
      {
        cachedInputUsdPerMillionTokens: 0.5,
        inputUsdPerMillionTokens: 1.25,
        modelId: "sync-priced-model",
        outputUsdPerMillionTokens: 4,
        source: "price_sync",
        status: "priced",
      },
      {
        inputUsdPerMillionTokens: 0.75,
        modelId: "litellm-priced-model",
        outputUsdPerMillionTokens: 1.5,
        source: "price_sync",
        status: "priced",
      },
    ]);
    await expect(readConfigPublication(fixture)).resolves.toEqual({
      providerModelsPriceChangeCount: "1",
      workerVersionCount: "1",
    });
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

test("refresh models writes synced provider model capabilities", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_model_capability_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer({
    models: [
      { id: "gpt-capable", name: "GPT Capable" },
      { id: "unknown-capability", name: "Unknown Capability" },
    ],
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${provider.url}/v1`,
      id: providerId,
      providerKey: "openai",
    });
    await insertProviderApiKey(fixture, providerId);

    const modelRefreshRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        model_refresh: createModelRefreshJobHandler({
          databaseUrl: fixture.databaseUrl,
          masterKeySource,
          modelPriceSource: async () => [],
          modelRegistrySource: async () => [
            {
              contextWindow: 128_000,
              modelId: "gpt-capable",
              outputTokenLimit: 16_384,
              providerKey: "openai",
              reasoningDefaultLevel: "medium",
              reasoningLevels: ["low", "medium", "high"],
              reasoningSupport: true,
              registrySources: {
                contextWindow: "models.dev",
                reasoning: "models.dev",
                supportsStreaming: "litellm",
                supportsTools: "models.dev",
              },
              streamingInferred: false,
              supportsStreaming: true,
              supportsTools: true,
              syncedAt,
            },
          ],
        }),
      },
      workerId: `worker-model-refresh-capabilities-${randomUUID()}`,
    });

    await enqueueProviderModelRefreshJob({
      databaseUrl: fixture.databaseUrl,
      providerId,
    });
    await expect(modelRefreshRunner.runOnce()).resolves.toBe(true);

    await expect(readProviderModelCapabilityRows(fixture)).resolves.toEqual([
      {
        capability_metadata: {
          outputTokenLimit: 16_384,
          reasoning: true,
          reasoningDefaultLevel: "medium",
          reasoningLevels: ["low", "medium", "high"],
          registrySources: {
            contextWindow: "models.dev",
            reasoning: "models.dev",
            supportsStreaming: "litellm",
            supportsTools: "models.dev",
          },
          registrySyncedAt: syncedAt.toISOString(),
          streamingInferred: false,
          tools: true,
        },
        context_window: 128_000,
        model_id: "gpt-capable",
        supports_streaming: true,
        supports_tools: true,
      },
    ]);

    const routeSeed = await seedRoutePolicyForProviderModels(fixture, providerId, ["gpt-capable"]);
    const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
    const routePolicy = snapshot.routePolicies.find(
      (candidate) => candidate.id === routeSeed.routePolicyId,
    );

    expect(routePolicy?.candidates).toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({
          reasoning: true,
          tools: true,
        }),
        contextWindow: 128_000,
        modelId: "gpt-capable",
        supportsTools: true,
      }),
    ]);
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type PriceSourceRow = {
  cachedInputUsdPerMillionTokens: number | null;
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  priceVersion: string;
  providerKey: string;
  source: "litellm" | "models.dev";
  sourceUrl: string;
  syncedAt: Date;
};

type PriceSyncOptions = Parameters<typeof createPriceSyncJobHandler>[0] & {
  priceSource: () => Promise<PriceSourceRow[]>;
};

type ProviderInput = {
  baseUrl: string;
  id: string;
  providerKey: string;
};

type ManualPriceInput = {
  cachedInputUsdPerMillionTokens: number;
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  providerId: string;
};

type RouteSeed = {
  routePolicyId: string;
};

type ProviderModelPriceRow = {
  cached_input_usd_per_million_tokens: string | null;
  input_usd_per_million_tokens: string;
  model_id: string;
  output_usd_per_million_tokens: string;
  price_version: string;
  provider_key: string;
  source: string;
  source_url: string;
};

type ProviderModelCapabilityRow = {
  capability_metadata: unknown;
  context_window: number | null;
  model_id: string;
  supports_streaming: boolean;
  supports_tools: boolean;
};

async function insertProvider(fixture: Fixture, input: ProviderInput): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [input.id, input.providerKey, input.providerKey, input.baseUrl],
  );
}

async function insertProviderApiKey(fixture: Fixture, providerId: string): Promise<void> {
  const encrypted = createSecretEncryption(masterKeySource).encrypt("sk-provider-model-price");
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, 'sk-price', $3, $4)
    `,
    [randomUUID(), providerId, JSON.stringify(encrypted), encrypted.keyId],
  );
}

async function readChainedPriceSyncJobId(
  fixture: Fixture,
  modelRefreshJobId: string,
): Promise<string> {
  const result = await fixture.query<{ result: unknown; status: string }>(
    "select status, result from jobs where id = $1",
    [modelRefreshJobId],
  );
  expect(result.rows[0]?.status).toBe("succeeded");
  const jobId = readResultString(result.rows[0]?.result, "chainedPriceSyncJobId");
  await expect(readJobResult(fixture, jobId)).resolves.toMatchObject({
    status: "pending",
  });
  return jobId;
}

async function setManualProviderModelPrice(
  fixture: Fixture,
  input: ManualPriceInput,
): Promise<void> {
  await fixture.query(
    `
      update provider_models
      set manual_input_usd_per_million_tokens = $3,
          manual_cached_input_usd_per_million_tokens = $4,
          manual_output_usd_per_million_tokens = $5,
          manual_price_updated_at = $6::timestamptz
      where provider_id = $1
        and model_id = $2
    `,
    [
      input.providerId,
      input.modelId,
      input.inputUsdPerMillionTokens,
      input.cachedInputUsdPerMillionTokens,
      input.outputUsdPerMillionTokens,
      "2026-06-17T00:01:00.000Z",
    ],
  );
}

async function seedRoutePolicyForProviderModels(
  fixture: Fixture,
  providerId: string,
  modelIds: string[],
): Promise<RouteSeed> {
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const models = await fixture.query<{ id: string; model_id: string }>(
    `
      select id::text, model_id
      from provider_models
      where provider_id = $1
        and model_id = any($2::text[])
      order by model_id
    `,
    [providerId, modelIds],
  );
  const modelsById = new Map(models.rows.map((row) => [row.model_id, row.id]));

  for (const modelId of modelIds) {
    if (!modelsById.has(modelId)) {
      throw new Error(`Provider model ${modelId} was not refreshed.`);
    }
  }

  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'feat-100-price-source', 'Feat 100 Price Source', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
  );

  let order = 1;
  for (const modelId of modelIds) {
    await fixture.query(
      `
        insert into route_policy_candidates (
          id,
          route_policy_id,
          provider_model_id,
          candidate_order
        )
        values ($1, $2, $3, $4)
      `,
      [randomUUID(), routePolicyId, modelsById.get(modelId), order],
    );
    order += 1;
  }

  return { routePolicyId };
}

async function readProviderModelPriceRows(fixture: Fixture): Promise<ProviderModelPriceRow[]> {
  const result = await fixture.query<ProviderModelPriceRow>(
    `
      select provider_key,
             model_id,
             synced_input_usd_per_million_tokens::text as input_usd_per_million_tokens,
             synced_cached_input_usd_per_million_tokens::text as cached_input_usd_per_million_tokens,
             synced_output_usd_per_million_tokens::text as output_usd_per_million_tokens,
             synced_price_source as source,
             synced_price_source_url as source_url,
             synced_price_version as price_version
      from provider_models
      join providers on providers.id = provider_models.provider_id
      where synced_price_version is not null
      order by provider_key, model_id, source
    `,
  );
  return result.rows;
}

async function readProviderModelIds(fixture: Fixture): Promise<string[]> {
  const result = await fixture.query<{ model_id: string }>(
    `
      select model_id
      from provider_models
      order by model_id
    `,
  );
  return result.rows.map((row) => row.model_id);
}

async function readProviderModelCapabilityRows(
  fixture: Fixture,
): Promise<ProviderModelCapabilityRow[]> {
  const result = await fixture.query<ProviderModelCapabilityRow>(
    `
      select model_id,
             context_window,
             supports_streaming,
             supports_tools,
             capability_metadata
      from provider_models
      order by model_id
    `,
  );
  return result.rows;
}

async function readRouteCandidatePrices(fixture: Fixture, routePolicyId: string) {
  const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
  const routePolicy = snapshot.routePolicies.find((candidate) => candidate.id === routePolicyId);

  if (!routePolicy) {
    throw new Error("Route policy was not loaded.");
  }

  return routePolicy.candidates.map((candidate) => {
    if (candidate.price.status === "unknown_price") {
      return {
        modelId: candidate.modelId,
        reason: candidate.price.reason,
        status: candidate.price.status,
      };
    }
    return {
      ...(candidate.price.cachedInputUsdPerMillionTokens === undefined
        ? {}
        : { cachedInputUsdPerMillionTokens: candidate.price.cachedInputUsdPerMillionTokens }),
      inputUsdPerMillionTokens: candidate.price.inputUsdPerMillionTokens,
      modelId: candidate.modelId,
      outputUsdPerMillionTokens: candidate.price.outputUsdPerMillionTokens,
      source: candidate.price.source,
      status: candidate.price.status,
    };
  });
}

async function readConfigPublication(fixture: Fixture): Promise<{
  providerModelsPriceChangeCount: string;
  workerVersionCount: string;
}> {
  const result = await fixture.query<{
    provider_models_price_change_count: string;
    worker_version_count: string;
  }>(
    `
      select (
               select count(*)::text
               from config_versions
               cross join lateral jsonb_array_elements(config_versions.changes) as change(value)
               where change.value->>'source' = 'worker'
                 and change.value->>'table' = 'provider_models'
             ) as provider_models_price_change_count,
             (
               select count(*)::text
               from config_versions
               where source = 'worker'
             ) as worker_version_count
    `,
  );
  const row = result.rows[0];
  return {
    providerModelsPriceChangeCount: row?.provider_models_price_change_count ?? "0",
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

function readResultString(result: unknown, key: string): string {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as Record<string, unknown>)[key] === "string"
  ) {
    return (result as Record<string, string>)[key];
  }
  throw new Error(`Expected job result ${key} to be a string.`);
}
