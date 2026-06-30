import { randomUUID } from "node:crypto";
import { type ConfigChange, createConfigPublisher } from "@llmingress/db/config-versions";
import {
  completeProviderOAuthConnection,
  isRemovedProviderKey,
  type PostgresQueryClient,
  readEnabledCompletedProviderOAuthConnections,
  withPostgresClient,
} from "@llmingress/db/providers";
import {
  fetchListedProviderModels as fetchProviderModelList,
  type ListedProviderModel,
} from "@llmingress/provider/model-list";
import { type ProviderOAuthTokenBlob, refreshProviderOAuthToken } from "@llmingress/provider/oauth";
import {
  fetchProviderModelPrices,
  fetchProviderModelRegistryEntries,
  findProviderModelRegistryEntry,
  type ProviderModelRegistryEntry,
  type ProviderModelSyncedPrice,
} from "@llmingress/provider/price-source";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { JOB_CREATED_CHANNEL, type JobHandler } from "./worker-job-runner.ts";

export type ProviderModelAvailability = "available" | "unavailable" | "not_listed" | "deprecated";
export type { ListedProviderModel } from "@llmingress/provider/model-list";
export { buildProviderModelListRequest } from "@llmingress/provider/model-list";

export type ExistingProviderModel = {
  availability: ProviderModelAvailability;
  capabilityMetadata?: Record<string, unknown>;
  contextWindow?: number | null;
  displayName: string;
  id: string;
  modelId: string;
  referenced: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
};

export type ProviderModelRefreshPlan = {
  insertModels: ListedProviderModel[];
  markAvailable: Array<ListedProviderModel & { id: string; referenced: boolean }>;
  markNotListed: Array<{ id: string; modelId: string; referenced: false }>;
  markUnavailable: Array<{ id: string; modelId: string; referenced: true }>;
  routingVisibleChanges: ConfigChange[];
};

export type ProviderModelRefreshResult = {
  chainedConnectivityCheckJobId: string | null;
  chainedPriceSyncJobId: string | null;
  fetchedModelCount: number;
  insertedModelCount: number;
  markedAvailableCount: number;
  markedNotListedCount: number;
  markedUnavailableCount: number;
  providerId: string;
  publishedConfigVersion: number | null;
  routingVisibleChangeCount: number;
};

export type ChainedPriceSyncJobPayload = {
  modelIds: string[];
  providerId: string;
  providerKey: string;
  source: "model_refresh";
};

export type ChainedConnectivityCheckJobPayload = {
  providerId: string;
  source: "model_refresh";
};

type CreateModelRefreshJobHandlerOptions = {
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  masterKeySource?: MasterKeySource;
  modelPriceSource?: () => Promise<ProviderModelSyncedPrice[]>;
  modelRegistrySource?: () => Promise<ProviderModelRegistryEntry[]>;
};

type RefreshProviderModelsOptions = CreateModelRefreshJobHandlerOptions & {
  providerId: string;
};

type PlanProviderModelRefreshInput = {
  existingModels: ExistingProviderModel[];
  listedModels: ListedProviderModel[];
};

type ProviderRow = {
  base_url: string | null;
  display_name: string;
  id: string;
  provider_key: string;
  provider_type: "api_key" | "local" | "subscription";
};

type ProviderModelRow = {
  availability: ProviderModelAvailability;
  capability_metadata: unknown;
  context_window: number | null;
  display_name: string;
  id: string;
  model_id: string;
  referenced: boolean;
  supports_streaming: boolean;
  supports_tools: boolean;
};

const workerManagedCapabilityMetadataKeys = [
  "tools",
  "reasoning",
  "reasoningLevels",
  "reasoningDefaultLevel",
  "outputTokenLimit",
  "registrySources",
  "streamingInferred",
] as const;
const localProviderKeys = new Set(["ollama", "lmstudio", "llama_cpp"]);
const defaultLocalProviderContextWindow = 4096;

export function createModelRefreshJobHandler(
  options: CreateModelRefreshJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const providerId = readProviderId(job.payload);
    return refreshProviderModels({ ...options, providerId });
  };
}

export function planProviderModelRefresh(
  input: PlanProviderModelRefreshInput,
): ProviderModelRefreshPlan {
  const listedModels = deduplicateListedModels(input.listedModels);
  const listedById = new Map(listedModels.map((model) => [model.modelId, model]));
  const existingByModelId = new Map(input.existingModels.map((model) => [model.modelId, model]));
  const insertModels = listedModels.filter((model) => !existingByModelId.has(model.modelId));
  const markAvailable: Array<ListedProviderModel & { id: string; referenced: boolean }> = [];
  const markUnavailable: Array<{ id: string; modelId: string; referenced: true }> = [];
  const markNotListed: Array<{ id: string; modelId: string; referenced: false }> = [];
  const routingVisibleChanges: ConfigChange[] = [];

  for (const existing of input.existingModels) {
    const listed = listedById.get(existing.modelId);
    if (listed) {
      const metadataChanged = providerModelMetadataChanged(existing, listed);
      if (
        existing.availability !== "available" ||
        existing.displayName !== listed.displayName ||
        metadataChanged
      ) {
        markAvailable.push({
          capabilityMetadata: listed.capabilityMetadata,
          contextWindow: listed.contextWindow,
          displayName: listed.displayName,
          id: existing.id,
          modelId: listed.modelId,
          referenced: existing.referenced,
          supportsStreaming: listed.supportsStreaming,
          supportsTools: listed.supportsTools,
        });

        if (existing.referenced && (existing.availability !== "available" || metadataChanged)) {
          routingVisibleChanges.push({ table: "provider_models", recordId: existing.id });
        }
      }
      continue;
    }

    if (existing.referenced) {
      if (existing.availability !== "unavailable") {
        markUnavailable.push({
          id: existing.id,
          modelId: existing.modelId,
          referenced: true,
        });
        routingVisibleChanges.push({ table: "provider_models", recordId: existing.id });
      }
      continue;
    }

    if (existing.availability !== "not_listed") {
      markNotListed.push({
        id: existing.id,
        modelId: existing.modelId,
        referenced: false,
      });
    }
  }

  return {
    insertModels,
    markAvailable,
    markNotListed,
    markUnavailable,
    routingVisibleChanges,
  };
}

function deduplicateListedModels(models: ListedProviderModel[]): ListedProviderModel[] {
  const seen = new Set<string>();
  const deduplicated: ListedProviderModel[] = [];

  for (const model of models) {
    if (seen.has(model.modelId)) {
      continue;
    }
    seen.add(model.modelId);
    deduplicated.push(model);
  }

  return deduplicated;
}

export function enrichListedProviderModels(input: {
  listedModels: ListedProviderModel[];
  providerKey: string;
  registryEntries: ProviderModelRegistryEntry[];
}): ListedProviderModel[] {
  const metadataProviderKey = providerMetadataKey(input.providerKey);

  return input.listedModels.map((model) => {
    const registryEntry = findProviderModelRegistryEntry(input.registryEntries, {
      displayName: model.displayName,
      modelId: model.modelId,
      providerKey: metadataProviderKey,
    });
    if (!registryEntry) {
      return withLocalProviderDefaults(model, input.providerKey);
    }

    return withLocalProviderDefaults(
      {
        ...model,
        capabilityMetadata: buildProviderModelCapabilityMetadata(registryEntry),
        ...(registryEntry.contextWindow === undefined || registryEntry.contextWindow === null
          ? {}
          : { contextWindow: registryEntry.contextWindow }),
        ...(registryEntry.supportsStreaming === undefined ||
        registryEntry.supportsStreaming === null
          ? {}
          : { supportsStreaming: registryEntry.supportsStreaming }),
        ...(registryEntry.supportsTools === undefined || registryEntry.supportsTools === null
          ? {}
          : { supportsTools: registryEntry.supportsTools }),
      },
      input.providerKey,
    );
  });
}

export function filterRefreshableListedProviderModels(input: {
  listedModels: ListedProviderModel[];
  providerKey: string;
  syncedPrices: ProviderModelSyncedPrice[];
}): ListedProviderModel[] {
  return input.listedModels.filter(
    (model) =>
      (model.contextWindow !== undefined && model.contextWindow !== null) ||
      findSyncedProviderModelPrice(input.syncedPrices, {
        displayName: model.displayName,
        modelId: model.modelId,
        providerKey: input.providerKey,
      }) !== null,
  );
}

function findSyncedProviderModelPrice(
  prices: ProviderModelSyncedPrice[],
  input: {
    displayName?: string | null;
    modelId: string;
    providerKey: string;
  },
): ProviderModelSyncedPrice | null {
  const providerKey = providerMetadataKey(input.providerKey);
  const candidates = new Set(
    [input.modelId, input.displayName ?? ""]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  return (
    prices.find(
      (price) =>
        price.providerKey.trim().toLowerCase() === providerKey &&
        candidates.has(price.modelId.trim().toLowerCase()),
    ) ?? null
  );
}

function providerMetadataKey(providerKey: string): string {
  const normalized = providerKey.trim().toLowerCase();

  if (normalized === "claude_code") {
    return "anthropic";
  }
  if (normalized === "openai_codex") {
    return "openai";
  }
  return normalized;
}

function withLocalProviderDefaults(
  model: ListedProviderModel,
  providerKey: string,
): ListedProviderModel {
  if (!localProviderKeys.has(providerKey.trim().toLowerCase()) || model.contextWindow != null) {
    return model;
  }
  return { ...model, contextWindow: defaultLocalProviderContextWindow };
}

function buildProviderModelCapabilityMetadata(
  entry: ProviderModelRegistryEntry,
): Record<string, unknown> {
  return {
    ...(entry.supportsTools === undefined || entry.supportsTools === null
      ? {}
      : { tools: entry.supportsTools }),
    ...(entry.reasoningSupport === undefined || entry.reasoningSupport === null
      ? {}
      : { reasoning: entry.reasoningSupport }),
    ...(entry.reasoningLevels?.length ? { reasoningLevels: entry.reasoningLevels } : {}),
    ...(entry.reasoningDefaultLevel ? { reasoningDefaultLevel: entry.reasoningDefaultLevel } : {}),
    ...(entry.outputTokenLimit === undefined || entry.outputTokenLimit === null
      ? {}
      : { outputTokenLimit: entry.outputTokenLimit }),
    ...(entry.registrySources && Object.keys(entry.registrySources).length > 0
      ? { registrySources: entry.registrySources }
      : {}),
    registrySyncedAt: entry.syncedAt.toISOString(),
    ...(entry.streamingInferred === undefined
      ? {}
      : { streamingInferred: entry.streamingInferred }),
  };
}

function providerModelMetadataChanged(
  existing: ExistingProviderModel,
  listed: ListedProviderModel,
): boolean {
  if (
    listed.contextWindow !== undefined &&
    listed.contextWindow !== null &&
    listed.contextWindow !== existing.contextWindow
  ) {
    return true;
  }
  if (
    listed.supportsTools !== undefined &&
    listed.supportsTools !== null &&
    listed.supportsTools !== existing.supportsTools
  ) {
    return true;
  }
  if (
    listed.supportsStreaming !== undefined &&
    listed.supportsStreaming !== null &&
    listed.supportsStreaming !== existing.supportsStreaming
  ) {
    return true;
  }

  const listedMetadata = listed.capabilityMetadata ?? {};
  const existingMetadata = existing.capabilityMetadata ?? {};
  if (listed.capabilityMetadata !== undefined) {
    for (const key of workerManagedCapabilityMetadataKeys) {
      if (!jsonMetadataValueEqual(existingMetadata[key], listedMetadata[key])) {
        return true;
      }
    }
  }

  return false;
}

function jsonMetadataValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readProviderModelRegistryEntries(input: {
  fetch: typeof globalThis.fetch;
  modelRegistrySource?: () => Promise<ProviderModelRegistryEntry[]>;
}): Promise<ProviderModelRegistryEntry[]> {
  try {
    return input.modelRegistrySource
      ? await input.modelRegistrySource()
      : await fetchProviderModelRegistryEntries({ fetch: input.fetch });
  } catch {
    return [];
  }
}

async function readProviderModelPrices(input: {
  fetch: typeof globalThis.fetch;
  modelPriceSource?: () => Promise<ProviderModelSyncedPrice[]>;
}): Promise<ProviderModelSyncedPrice[]> {
  try {
    return input.modelPriceSource
      ? await input.modelPriceSource()
      : await fetchProviderModelPrices({ fetch: input.fetch });
  } catch {
    return [];
  }
}

export async function refreshProviderModels(
  options: RefreshProviderModelsOptions,
): Promise<ProviderModelRefreshResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const provider = await readProvider(options.databaseUrl, options.providerId);
  const apiKey =
    provider.provider_type === "api_key"
      ? await readProviderApiKey({
          databaseUrl: options.databaseUrl,
          masterKeySource: options.masterKeySource ?? readWorkerMasterKeySource(),
          providerId: provider.id,
        })
      : provider.provider_type === "subscription"
        ? await readProviderOAuthAccessToken({
            databaseUrl: options.databaseUrl,
            fetch: fetchImpl,
            masterKeySource: options.masterKeySource ?? readWorkerMasterKeySource(),
            providerId: provider.id,
            providerKey: provider.provider_key,
          })
        : null;
  const rawListedModels = await fetchProviderModelList({
    apiKey,
    baseUrl: provider.base_url as string,
    fetch: fetchImpl,
    providerKey: provider.provider_key,
  });
  const [registryEntries, syncedPrices] = await Promise.all([
    readProviderModelRegistryEntries({
      fetch: fetchImpl,
      modelRegistrySource: options.modelRegistrySource,
    }),
    readProviderModelPrices({
      fetch: fetchImpl,
      modelPriceSource: options.modelPriceSource,
    }),
  ]);
  const enrichedListedModels = enrichListedProviderModels({
    listedModels: rawListedModels,
    providerKey: provider.provider_key,
    registryEntries,
  });
  const listedModels = filterRefreshableListedProviderModels({
    listedModels: enrichedListedModels,
    providerKey: provider.provider_key,
    syncedPrices,
  });
  const existingModels = await readExistingProviderModels(options.databaseUrl, provider.id);
  const plan = planProviderModelRefresh({ existingModels, listedModels });
  let chainedConnectivityCheckJobId: string | null = null;
  let chainedPriceSyncJobId: string | null = null;
  const writePlan = async (client: QueryClient) => {
    await applyProviderModelRefreshPlan(client, provider.id, plan);
    if (listedModels.length > 0) {
      chainedConnectivityCheckJobId = await enqueueChainedConnectivityCheckJob(client, {
        providerId: provider.id,
      });
    }
    chainedPriceSyncJobId = await enqueueChainedPriceSyncJob(client, {
      listedModels,
      providerId: provider.id,
      providerKey: provider.provider_key,
    });
  };
  let publishedConfigVersion: number | null = null;

  if (plan.routingVisibleChanges.length > 0) {
    const publisher = createConfigPublisher({ databaseUrl: options.databaseUrl });
    const result = await publisher.publish({
      source: "worker",
      description: `Refresh provider models for ${provider.provider_key}`,
      changes: plan.routingVisibleChanges,
      write: writePlan,
    });
    publishedConfigVersion = result.version;
  } else {
    await withPostgresClient(options.databaseUrl, async (client) => {
      await client.query("begin");
      try {
        await writePlan(client);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  return {
    chainedConnectivityCheckJobId,
    chainedPriceSyncJobId,
    fetchedModelCount: rawListedModels.length,
    insertedModelCount: plan.insertModels.length,
    markedAvailableCount: plan.markAvailable.length,
    markedNotListedCount: plan.markNotListed.length,
    markedUnavailableCount: plan.markUnavailable.length,
    providerId: provider.id,
    publishedConfigVersion,
    routingVisibleChangeCount: plan.routingVisibleChanges.length,
  };
}

export function buildChainedPriceSyncJobPayload(input: {
  listedModels: ListedProviderModel[];
  providerId: string;
  providerKey: string;
}): ChainedPriceSyncJobPayload {
  return {
    modelIds: [...new Set(input.listedModels.map((model) => model.modelId))].sort(),
    providerId: input.providerId,
    providerKey: input.providerKey.trim().toLowerCase(),
    source: "model_refresh",
  };
}

export function isUnfinishedChainedPriceSyncStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

export function buildChainedConnectivityCheckJobPayload(input: {
  providerId: string;
}): ChainedConnectivityCheckJobPayload {
  return {
    providerId: input.providerId,
    source: "model_refresh",
  };
}

export function isUnfinishedChainedConnectivityCheckStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

async function enqueueChainedConnectivityCheckJob(
  client: QueryClient,
  input: {
    providerId: string;
  },
): Promise<string> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `model_refresh_connectivity_check:${input.providerId}`,
  ]);

  const existing = await client.query<{ id: string; status: string }>(
    `
      select id::text, status
      from jobs
      where job_type = 'provider_connectivity_check'
        and trigger = 'system'
        and payload->>'source' = 'model_refresh'
        and payload->>'providerId' = $1
        and status in ('pending', 'running')
      order by created_at
      limit 1
      for update
    `,
    [input.providerId],
  );
  const existingJob = existing.rows.find((row) =>
    isUnfinishedChainedConnectivityCheckStatus(row.status),
  );
  if (existingJob) {
    await notifyJobCreated(client, existingJob.id);
    return existingJob.id;
  }

  const jobId = randomUUID();
  await client.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'provider_connectivity_check', 'pending', 'system', $2::jsonb, 1)
    `,
    [jobId, JSON.stringify(buildChainedConnectivityCheckJobPayload(input))],
  );
  await notifyJobCreated(client, jobId);
  return jobId;
}

async function enqueueChainedPriceSyncJob(
  client: QueryClient,
  input: {
    listedModels: ListedProviderModel[];
    providerId: string;
    providerKey: string;
  },
): Promise<string> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `model_refresh_price_sync:${input.providerId}`,
  ]);

  const existing = await client.query<{ id: string; status: string }>(
    `
      select id::text, status
      from jobs
      where job_type = 'price_sync'
        and trigger = 'system'
        and payload->>'source' = 'model_refresh'
        and payload->>'providerId' = $1
        and status in ('pending', 'running')
      order by created_at
      limit 1
      for update
    `,
    [input.providerId],
  );
  const existingJob = existing.rows.find((row) => isUnfinishedChainedPriceSyncStatus(row.status));
  if (existingJob) {
    await notifyJobCreated(client, existingJob.id);
    return existingJob.id;
  }

  const jobId = randomUUID();
  await client.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'price_sync', 'pending', 'system', $2::jsonb, 3)
    `,
    [jobId, JSON.stringify(buildChainedPriceSyncJobPayload(input))],
  );
  await notifyJobCreated(client, jobId);
  return jobId;
}

async function notifyJobCreated(client: QueryClient, jobId: string): Promise<void> {
  await client.query("select pg_notify($1, $2)", [JOB_CREATED_CHANNEL, JSON.stringify({ jobId })]);
}

type QueryClient = PostgresQueryClient;

async function readProvider(databaseUrl: string, providerId: string): Promise<ProviderRow> {
  return withPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderRow>(
      `
        select id::text, provider_type, provider_key, display_name, base_url
        from providers
        where id = $1
          and enabled = true
          and deleted_at is null
      `,
      [providerId],
    );
    const provider = result.rows[0];
    if (!provider) {
      throw new Error("Provider was not found.");
    }
    if (isRemovedProviderKey(provider.provider_key)) {
      throw new Error("Provider is no longer supported.");
    }
    if (!provider.base_url) {
      throw new Error("Provider base URL is required for model refresh.");
    }
    return provider;
  });
}

async function readExistingProviderModels(
  databaseUrl: string,
  providerId: string,
): Promise<ExistingProviderModel[]> {
  return withPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderModelRow>(
      `
        select provider_models.id::text,
               provider_models.model_id,
               provider_models.display_name,
               provider_models.availability,
               provider_models.context_window,
               provider_models.supports_streaming,
               provider_models.supports_tools,
               provider_models.capability_metadata,
               exists (
                 select 1
                 from route_policy_candidates
                 where route_policy_candidates.provider_model_id = provider_models.id
               ) as referenced
        from provider_models
        where provider_models.provider_id = $1
          and provider_models.deleted_at is null
        order by provider_models.model_id
      `,
      [providerId],
    );

    return result.rows.map((row) => ({
      availability: row.availability,
      capabilityMetadata: readJsonRecord(row.capability_metadata),
      contextWindow: row.context_window,
      displayName: row.display_name,
      id: row.id,
      modelId: row.model_id,
      referenced: row.referenced,
      supportsStreaming: row.supports_streaming,
      supportsTools: row.supports_tools,
    }));
  });
}

async function applyProviderModelRefreshPlan(
  client: QueryClient,
  providerId: string,
  plan: ProviderModelRefreshPlan,
): Promise<void> {
  for (const model of plan.insertModels) {
    await client.query(
      `
        insert into provider_models (
          id,
          provider_id,
          model_id,
          display_name,
          context_window,
          supports_tools,
          supports_streaming,
          capability_metadata,
          availability
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'available')
        on conflict (provider_id, model_id) do update
        set display_name = excluded.display_name,
            context_window = coalesce(excluded.context_window, provider_models.context_window),
            supports_tools = excluded.supports_tools,
            supports_streaming = excluded.supports_streaming,
            capability_metadata = (
              provider_models.capability_metadata
              - 'tools'
              - 'reasoning'
              - 'reasoningLevels'
              - 'reasoningDefaultLevel'
              - 'outputTokenLimit'
              - 'registrySources'
              - 'registrySyncedAt'
              - 'streamingInferred'
            ) || excluded.capability_metadata,
            availability = 'available',
            updated_at = now()
      `,
      [
        randomUUID(),
        providerId,
        model.modelId,
        model.displayName,
        model.contextWindow ?? null,
        model.supportsTools ?? false,
        model.supportsStreaming ?? false,
        JSON.stringify(model.capabilityMetadata ?? {}),
      ],
    );
  }

  for (const model of plan.markAvailable) {
    await client.query(
      `
        update provider_models
        set display_name = $2,
            availability = 'available',
            context_window = coalesce($3::integer, context_window),
            supports_tools = coalesce($4::boolean, supports_tools),
            supports_streaming = coalesce($5::boolean, supports_streaming),
            capability_metadata = (
              capability_metadata
              - 'tools'
              - 'reasoning'
              - 'reasoningLevels'
              - 'reasoningDefaultLevel'
              - 'outputTokenLimit'
              - 'registrySources'
              - 'registrySyncedAt'
              - 'streamingInferred'
            ) || $6::jsonb,
            updated_at = now()
        where id = $1
          and deleted_at is null
      `,
      [
        model.id,
        model.displayName,
        model.contextWindow ?? null,
        model.supportsTools ?? null,
        model.supportsStreaming ?? null,
        JSON.stringify(model.capabilityMetadata ?? {}),
      ],
    );
  }

  for (const model of plan.markUnavailable) {
    await client.query(
      `
        update provider_models
        set availability = 'unavailable',
            updated_at = now()
        where id = $1
          and deleted_at is null
      `,
      [model.id],
    );
  }

  for (const model of plan.markNotListed) {
    await client.query(
      `
        update provider_models
        set availability = 'not_listed',
            updated_at = now()
        where id = $1
          and deleted_at is null
      `,
      [model.id],
    );
  }
}

function readProviderId(payload: unknown): string {
  if (isRecord(payload) && typeof payload.providerId === "string" && payload.providerId.trim()) {
    return payload.providerId;
  }
  throw new Error("model_refresh job payload requires providerId.");
}

async function readProviderApiKey(input: {
  databaseUrl: string;
  masterKeySource: MasterKeySource;
  providerId: string;
}): Promise<string> {
  const encrypted = await withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<{ encrypted_key: unknown }>(
      `
        select encrypted_key
        from provider_api_keys
        where provider_id = $1
      `,
      [input.providerId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Provider API key was not found.");
    }
    return readEncryptedSecret(row.encrypted_key);
  });

  return createSecretEncryption(input.masterKeySource).decrypt(encrypted);
}

async function readProviderOAuthAccessToken(input: {
  databaseUrl: string;
  fetch: typeof globalThis.fetch;
  masterKeySource: MasterKeySource;
  providerId: string;
  providerKey: string;
}): Promise<string> {
  if (!isSubscriptionProviderKey(input.providerKey)) {
    throw new Error("Provider does not support OAuth model refresh.");
  }
  const connections = await readEnabledCompletedProviderOAuthConnections({
    databaseUrl: input.databaseUrl,
    providerId: input.providerId,
  });
  const connection = connections[0];
  if (!connection) {
    throw new Error("Provider OAuth connection was not found.");
  }

  const encryption = createSecretEncryption(input.masterKeySource);
  const token = readProviderOAuthTokenBlob(
    encryption.decrypt(readEncryptedSecret(connection.encryptedToken)),
  );
  if (!isProviderOAuthTokenExpired(token)) {
    return token.accessToken;
  }
  if (!token.refreshToken) {
    throw new Error("Provider OAuth token expired and has no refresh token.");
  }

  const refreshed = await refreshProviderOAuthToken({
    fetch: input.fetch,
    providerKey: input.providerKey,
    refreshToken: token.refreshToken,
  });
  await completeProviderOAuthConnection({
    databaseUrl: input.databaseUrl,
    encryptedToken: encryption.encrypt(JSON.stringify(refreshed)),
    providerOAuthId: connection.id,
    tokenExpiresAt: refreshed.expiresAt === null ? null : new Date(refreshed.expiresAt),
  });
  return refreshed.accessToken;
}

function readWorkerMasterKeySource(
  env: Record<string, string | undefined> = process.env,
): MasterKeySource {
  const inlineKey = env.MASTER_KEY;
  if (inlineKey?.trim()) {
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.MASTER_KEY_FILE;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required for provider model refresh.");
}

function readEncryptedSecret(value: unknown): EncryptedSecret {
  if (
    isRecord(value) &&
    value.version === 1 &&
    value.algorithm === "aes-256-gcm" &&
    typeof value.keyId === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.authTag === "string"
  ) {
    return value as EncryptedSecret;
  }

  throw new Error("Stored provider credential is not a valid encrypted secret.");
}

function readProviderOAuthTokenBlob(value: string): ProviderOAuthTokenBlob {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
      return {
        accessToken: parsed.accessToken,
        expiresAt:
          typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)
            ? parsed.expiresAt
            : null,
        refreshToken:
          typeof parsed.refreshToken === "string" && parsed.refreshToken.trim()
            ? parsed.refreshToken
            : null,
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
        tokenType:
          typeof parsed.tokenType === "string" && parsed.tokenType.trim()
            ? parsed.tokenType
            : "Bearer",
      };
    }
  } catch {
    // handled by final throw
  }
  throw new Error("Stored provider OAuth token was not recognized.");
}

function isProviderOAuthTokenExpired(token: ProviderOAuthTokenBlob): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
