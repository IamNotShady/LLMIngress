import { randomUUID } from "node:crypto";
import { withPostgresTransaction } from "@llmingress/db/client";
import { type ConfigChange, publishConfigChangeWithClient } from "@llmingress/db/config-versions";
import {
  completeProviderOAuthConnection,
  type PostgresQueryClient,
  readEnabledCompletedProviderOAuthConnections,
  withPooledPostgresClient,
} from "@llmingress/db/providers";
import {
  type ModelInputModality,
  type ModelOutputModality,
  type ProviderModelCapabilityMetadata,
  resolveProviderModelCapabilities,
  type SyncedModelCapabilities,
} from "@llmingress/domain";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import {
  fetchListedProviderModels as fetchProviderModelList,
  type ListedProviderModel,
} from "@llmingress/provider/model-list";
import { refreshProviderOAuthToken } from "@llmingress/provider/oauth";
import {
  fetchProviderModelRegistryEntries,
  type ProviderModelRegistryEntry,
  resolveProviderModelMetadataEntry,
} from "@llmingress/provider/price-source";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { EncryptionKeySource } from "@llmingress/security/encryption-key";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { isRecord } from "@llmingress/util";
import {
  isProviderOAuthTokenExpired,
  readEncryptedSecret,
  readProviderOAuthTokenBlob,
  readWorkerEncryptionKeySource,
} from "./worker-credential-utils.ts";
import { JOB_CREATED_CHANNEL, type JobHandler, JobHandlerError } from "./worker-job-runner.ts";

export type ProviderModelAvailability = "available" | "unavailable" | "not_listed" | "deprecated";
export type { ListedProviderModel } from "@llmingress/provider/model-list";
export { buildProviderModelListRequest } from "@llmingress/provider/model-list";

export type ExistingProviderModel = {
  availability: ProviderModelAvailability;
  capabilityMetadata?: Record<string, unknown>;
  contextWindow?: number | null;
  displayName: string;
  id: string;
  inputModalities?: ModelInputModality[] | null;
  maxOutputTokens?: number | null;
  modelId: string;
  outputModalities?: ModelOutputModality[] | null;
  referenced: boolean;
  supportsFunctionCalling?: boolean | null;
  supportsReasoning?: boolean | null;
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

type CreateModelRefreshJobHandlerOptions = {
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  encryptionKeySource?: EncryptionKeySource;
  modelRegistrySource?: () => Promise<ProviderModelRegistryEntry[]>;
};

export type RefreshProviderModelsOptions = CreateModelRefreshJobHandlerOptions & {
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
  updated_at: string;
};

type ProviderCredentialSnapshot = {
  encryptedSecret: Record<string, unknown>;
  id: string;
  kind: "api_key" | "oauth";
};

function requireProviderBaseUrl(provider: ProviderRow): string {
  if (!provider.base_url) {
    throw new JobHandlerError(
      "provider_base_url_missing",
      `Provider ${provider.provider_key} has no base URL for model refresh.`,
    );
  }
  return provider.base_url;
}

type ProviderModelRow = {
  availability: ProviderModelAvailability;
  capability_metadata: unknown;
  context_window: number | null;
  display_name: string;
  id: string;
  input_modalities: ModelInputModality[] | null;
  max_output_tokens: number | null;
  model_id: string;
  output_modalities: ModelOutputModality[] | null;
  referenced: boolean;
  supports_function_calling: boolean | null;
  supports_reasoning: boolean | null;
  supports_streaming: boolean;
};

const workerManagedCapabilityMetadataKeys = [
  "syncedCapabilities",
  "tools",
  "reasoning",
  "reasoningLevels",
  "reasoningDefaultLevel",
  "outputTokenLimit",
  "registrySources",
  "streamingInferred",
] as const;
const defaultLocalProviderContextWindow = 4096;

export function createModelRefreshJobHandler(
  options: CreateModelRefreshJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const payload = readModelRefreshPayload(job.payload);
    return refreshProviderModels({
      ...options,
      providerId: payload.providerId,
    });
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
      const effectiveListed = applyExistingManualCapabilities(listed, existing);
      const metadataChanged = providerModelMetadataChanged(existing, effectiveListed);
      if (
        existing.availability !== "available" ||
        existing.displayName !== effectiveListed.displayName ||
        metadataChanged
      ) {
        markAvailable.push({
          capabilityMetadata: effectiveListed.capabilityMetadata,
          contextWindow: effectiveListed.contextWindow,
          displayName: effectiveListed.displayName,
          id: existing.id,
          inputModalities: effectiveListed.inputModalities,
          maxOutputTokens: effectiveListed.maxOutputTokens,
          modelId: effectiveListed.modelId,
          outputModalities: effectiveListed.outputModalities,
          referenced: existing.referenced,
          supportsFunctionCalling: effectiveListed.supportsFunctionCalling,
          supportsReasoning: effectiveListed.supportsReasoning,
          supportsStreaming: effectiveListed.supportsStreaming,
          supportsTools: effectiveListed.supportsTools,
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
    const registryEntry = resolveProviderModelMetadataEntry(input.registryEntries, {
      displayName: model.displayName,
      modelId: model.modelId,
      providerKey: metadataProviderKey,
    });
    if (!registryEntry) {
      return withLocalProviderDefaults(model, input.providerKey);
    }

    const syncedCapabilities = buildListedSyncedCapabilities(model, registryEntry);
    const capabilityMetadata = buildProviderModelCapabilityMetadata(registryEntry, {
      syncedCapabilities,
    });

    return withLocalProviderDefaults(
      {
        ...model,
        capabilityMetadata,
        ...(syncedCapabilities.inputModalities === undefined ||
        syncedCapabilities.inputModalities === null
          ? {}
          : { inputModalities: syncedCapabilities.inputModalities }),
        ...(syncedCapabilities.maxContextTokens === undefined ||
        syncedCapabilities.maxContextTokens === null
          ? {}
          : { contextWindow: syncedCapabilities.maxContextTokens }),
        ...(syncedCapabilities.maxOutputTokens === undefined ||
        syncedCapabilities.maxOutputTokens === null
          ? {}
          : { maxOutputTokens: syncedCapabilities.maxOutputTokens }),
        ...(syncedCapabilities.outputModalities === undefined ||
        syncedCapabilities.outputModalities === null
          ? {}
          : { outputModalities: syncedCapabilities.outputModalities }),
        ...(syncedCapabilities.supportsFunctionCalling === undefined ||
        syncedCapabilities.supportsFunctionCalling === null
          ? {}
          : {
              supportsFunctionCalling: syncedCapabilities.supportsFunctionCalling,
              supportsTools: syncedCapabilities.supportsFunctionCalling,
            }),
        ...(syncedCapabilities.supportsReasoning === undefined ||
        syncedCapabilities.supportsReasoning === null
          ? {}
          : { supportsReasoning: syncedCapabilities.supportsReasoning }),
        ...(registryEntry.supportsStreaming === undefined ||
        registryEntry.supportsStreaming === null
          ? {}
          : { supportsStreaming: registryEntry.supportsStreaming }),
      },
      input.providerKey,
    );
  });
}

function providerMetadataKey(providerKey: string): string {
  const normalized = providerKey.trim().toLowerCase();
  return resolveProviderDescriptor(normalized).metadataKey ?? normalized;
}

function withLocalProviderDefaults(
  model: ListedProviderModel,
  providerKey: string,
): ListedProviderModel {
  if (resolveProviderDescriptor(providerKey).local !== true || model.contextWindow != null) {
    return model;
  }
  return { ...model, contextWindow: defaultLocalProviderContextWindow };
}

function buildListedSyncedCapabilities(
  listed: ListedProviderModel,
  registryEntry: ProviderModelRegistryEntry,
): Partial<SyncedModelCapabilities> {
  return {
    inputModalities: listed.inputModalities ?? registryEntry.inputModalities,
    maxContextTokens: listed.contextWindow ?? registryEntry.maxContextTokens,
    maxOutputTokens: listed.maxOutputTokens ?? registryEntry.maxOutputTokens,
    outputModalities: listed.outputModalities ?? registryEntry.outputModalities,
    supportsFunctionCalling:
      listed.supportsFunctionCalling ??
      listed.supportsTools ??
      registryEntry.supportsFunctionCalling,
    supportsReasoning: listed.supportsReasoning ?? registryEntry.supportsReasoning,
  };
}

function buildProviderModelCapabilityMetadata(
  entry: ProviderModelRegistryEntry,
  input: {
    syncedCapabilities: Partial<SyncedModelCapabilities>;
  },
): Record<string, unknown> {
  const resolved = resolveProviderModelCapabilities({
    registrySources: entry.registrySources,
    registrySyncedAt: entry.syncedAt.toISOString(),
    syncedCapabilities: input.syncedCapabilities,
  });

  return {
    ...resolved.metadata,
    ...(entry.reasoningLevels?.length ? { reasoningLevels: entry.reasoningLevels } : {}),
    ...(entry.reasoningDefaultLevel ? { reasoningDefaultLevel: entry.reasoningDefaultLevel } : {}),
    ...(entry.streamingInferred === undefined
      ? {}
      : { streamingInferred: entry.streamingInferred }),
  };
}

function applyExistingManualCapabilities(
  listed: ListedProviderModel,
  existing: ExistingProviderModel,
): ListedProviderModel {
  const listedMetadata = readCapabilityMetadata(listed.capabilityMetadata);
  const existingMetadata = readCapabilityMetadata(existing.capabilityMetadata);
  const syncedCapabilities =
    listedMetadata.syncedCapabilities ?? buildSyncedCapabilitiesFromListedModel(listed);
  const resolved = resolveProviderModelCapabilities({
    manualCapabilities: existingMetadata.manualCapabilities,
    registrySources: listedMetadata.registrySources,
    registrySyncedAt: listedMetadata.registrySyncedAt,
    syncedCapabilities,
  });
  const effective = resolved.effectiveCapabilities;

  return {
    ...listed,
    capabilityMetadata: {
      ...(listed.capabilityMetadata ?? {}),
      ...resolved.metadata,
    },
    inputModalities: effective.inputModalities,
    contextWindow: effective.maxContextTokens,
    maxOutputTokens: effective.maxOutputTokens,
    outputModalities: effective.outputModalities,
    supportsFunctionCalling: effective.supportsFunctionCalling,
    supportsReasoning: effective.supportsReasoning,
    supportsTools: effective.supportsFunctionCalling,
  };
}

function buildSyncedCapabilitiesFromListedModel(
  listed: ListedProviderModel,
): Partial<SyncedModelCapabilities> {
  return {
    inputModalities: listed.inputModalities,
    maxContextTokens: listed.contextWindow,
    maxOutputTokens: listed.maxOutputTokens,
    outputModalities: listed.outputModalities,
    supportsFunctionCalling: listed.supportsFunctionCalling ?? listed.supportsTools,
    supportsReasoning: listed.supportsReasoning,
  };
}

function readCapabilityMetadata(
  value: Record<string, unknown> | undefined,
): ProviderModelCapabilityMetadata {
  const record = value ?? {};
  return {
    manualCapabilities: isRecord(record.manualCapabilities)
      ? (record.manualCapabilities as ProviderModelCapabilityMetadata["manualCapabilities"])
      : undefined,
    registrySources: isRecord(record.registrySources)
      ? (record.registrySources as ProviderModelCapabilityMetadata["registrySources"])
      : undefined,
    registrySyncedAt:
      typeof record.registrySyncedAt === "string" ? record.registrySyncedAt : undefined,
    syncedCapabilities: isRecord(record.syncedCapabilities)
      ? (record.syncedCapabilities as ProviderModelCapabilityMetadata["syncedCapabilities"])
      : undefined,
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
    listed.inputModalities !== undefined &&
    listed.inputModalities !== null &&
    !jsonMetadataValueEqual(listed.inputModalities, existing.inputModalities)
  ) {
    return true;
  }
  if (
    listed.maxOutputTokens !== undefined &&
    listed.maxOutputTokens !== null &&
    listed.maxOutputTokens !== existing.maxOutputTokens
  ) {
    return true;
  }
  if (
    listed.outputModalities !== undefined &&
    listed.outputModalities !== null &&
    !jsonMetadataValueEqual(listed.outputModalities, existing.outputModalities)
  ) {
    return true;
  }
  if (
    listed.supportsFunctionCalling !== undefined &&
    listed.supportsFunctionCalling !== null &&
    listed.supportsFunctionCalling !== existing.supportsFunctionCalling
  ) {
    return true;
  }
  if (
    listed.supportsReasoning !== undefined &&
    listed.supportsReasoning !== null &&
    listed.supportsReasoning !== existing.supportsReasoning
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

export async function refreshProviderModels(
  options: RefreshProviderModelsOptions,
): Promise<ProviderModelRefreshResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const provider = await readProvider(options.databaseUrl, options.providerId);
  const credential =
    provider.provider_type === "api_key"
      ? await readProviderApiKey({
          databaseUrl: options.databaseUrl,
          encryptionKeySource:
            options.encryptionKeySource ??
            readWorkerEncryptionKeySource(process.env, "provider model refresh"),
          providerId: provider.id,
        })
      : provider.provider_type === "subscription"
        ? await readProviderOAuthAccessToken({
            databaseUrl: options.databaseUrl,
            fetch: fetchImpl,
            encryptionKeySource:
              options.encryptionKeySource ??
              readWorkerEncryptionKeySource(process.env, "provider model refresh"),
            providerId: provider.id,
            providerKey: provider.provider_key,
          })
        : null;
  const rawListedModels = await fetchProviderModelList({
    apiKey: credential?.plaintext ?? null,
    baseUrl: requireProviderBaseUrl(provider),
    fetch: fetchImpl,
    providerKey: provider.provider_key,
  });
  const registryEntries = await readProviderModelRegistryEntries({
    fetch: fetchImpl,
    modelRegistrySource: options.modelRegistrySource,
  });
  const enrichedListedModels = enrichListedProviderModels({
    listedModels: rawListedModels,
    providerKey: provider.provider_key,
    registryEntries,
  });
  const listedModels = enrichedListedModels;
  let plan: ProviderModelRefreshPlan | undefined;
  let publishedConfigVersion: number | null = null;
  let chainedPriceSyncJobId: string | null = null;
  await withPostgresTransaction(options.databaseUrl, async (client) => {
    await assertProviderSnapshotCurrent(client, provider, credential?.snapshot ?? null);
    const existingModels = await readExistingProviderModels(client, provider.id);
    plan = planProviderModelRefresh({ existingModels, listedModels });
    const writePlan = async (writeClient: QueryClient) => {
      const currentPlan = requireRefreshPlan(plan);
      await applyProviderModelRefreshPlan(writeClient, provider.id, currentPlan);
      chainedPriceSyncJobId = await enqueueChainedPriceSyncJob(writeClient, {
        listedModels,
        providerId: provider.id,
        providerKey: provider.provider_key,
      });
    };
    if (plan.routingVisibleChanges.length > 0) {
      const result = await publishConfigChangeWithClient(client, {
        source: "worker",
        description: `Refresh provider models for ${provider.provider_key}`,
        changes: plan.routingVisibleChanges,
        write: writePlan,
      });
      publishedConfigVersion = result.version;
    } else {
      await writePlan(client);
    }
  });

  const committedPlan = requireRefreshPlan(plan);

  return {
    chainedConnectivityCheckJobId: null,
    chainedPriceSyncJobId,
    fetchedModelCount: rawListedModels.length,
    insertedModelCount: committedPlan.insertModels.length,
    markedAvailableCount: committedPlan.markAvailable.length,
    markedNotListedCount: committedPlan.markNotListed.length,
    markedUnavailableCount: committedPlan.markUnavailable.length,
    providerId: provider.id,
    publishedConfigVersion,
    routingVisibleChangeCount: committedPlan.routingVisibleChanges.length,
  };
}

function requireRefreshPlan(plan: ProviderModelRefreshPlan | undefined): ProviderModelRefreshPlan {
  if (!plan) {
    throw new Error("Provider model refresh plan was not created.");
  }
  return plan;
}

async function assertProviderSnapshotCurrent(
  client: QueryClient,
  provider: ProviderRow,
  credential: ProviderCredentialSnapshot | null,
): Promise<void> {
  const result = await client.query<{ current: boolean }>(
    `
      select enabled
             and deleted_at is null
             and updated_at::text = $2
             and base_url is not distinct from $3
             and provider_type = $4
             as current
      from providers
      where id = $1
      for update
    `,
    [provider.id, provider.updated_at, provider.base_url, provider.provider_type],
  );
  if (result.rows[0]?.current !== true) {
    throw new JobHandlerError(
      "provider_probe_snapshot_stale",
      "Provider configuration changed while the probe was running.",
    );
  }
  if (!credential) {
    return;
  }
  const table = credential.kind === "api_key" ? "provider_api_keys" : "provider_oauth";
  const secretColumn = credential.kind === "api_key" ? "encrypted_key" : "encrypted_token";
  const credentialResult = await client.query<{ current: boolean }>(
    `
      select enabled
             and ${secretColumn} = $2::jsonb
             as current
      from ${table}
      where id = $1
        and provider_id = $3
      for update
    `,
    [credential.id, JSON.stringify(credential.encryptedSecret), provider.id],
  );
  if (credentialResult.rows[0]?.current !== true) {
    throw new JobHandlerError(
      "provider_probe_snapshot_stale",
      "Provider credentials changed while the probe was running.",
    );
  }
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

async function readProvider(
  databaseUrl: string | undefined,
  providerId: string,
): Promise<ProviderRow> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderRow>(
      `
        select id::text, provider_type, provider_key, display_name, base_url, updated_at::text
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
    if (!provider.base_url) {
      throw new Error("Provider base URL is required for model refresh.");
    }
    return provider;
  });
}

async function readExistingProviderModels(
  client: QueryClient,
  providerId: string,
): Promise<ExistingProviderModel[]> {
  const result = await client.query<ProviderModelRow>(
    `
        select provider_models.id::text,
               provider_models.model_id,
               provider_models.display_name,
               provider_models.availability,
               provider_models.input_modalities,
               provider_models.output_modalities,
               provider_models.context_window,
               provider_models.max_output_tokens,
               provider_models.supports_function_calling,
               provider_models.supports_reasoning,
               provider_models.supports_streaming,
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
    inputModalities: row.input_modalities,
    maxOutputTokens: row.max_output_tokens,
    modelId: row.model_id,
    outputModalities: row.output_modalities,
    referenced: row.referenced,
    supportsFunctionCalling: row.supports_function_calling,
    supportsReasoning: row.supports_reasoning,
    supportsStreaming: row.supports_streaming,
    supportsTools: row.supports_function_calling ?? undefined,
  }));
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
          input_modalities,
          output_modalities,
          context_window,
          max_output_tokens,
          supports_function_calling,
          supports_reasoning,
          supports_streaming,
          capability_metadata,
          availability
        )
        values ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9, $10, $11, $12::jsonb, 'available')
        on conflict (provider_id, model_id) do update
        set display_name = excluded.display_name,
            input_modalities = coalesce(excluded.input_modalities, provider_models.input_modalities),
            output_modalities = coalesce(excluded.output_modalities, provider_models.output_modalities),
            context_window = coalesce(excluded.context_window, provider_models.context_window),
            max_output_tokens = coalesce(excluded.max_output_tokens, provider_models.max_output_tokens),
            supports_function_calling = coalesce(excluded.supports_function_calling, provider_models.supports_function_calling),
            supports_reasoning = coalesce(excluded.supports_reasoning, provider_models.supports_reasoning),
            supports_streaming = excluded.supports_streaming,
            capability_metadata = (
              provider_models.capability_metadata
              - 'syncedCapabilities'
              - 'conflicts'
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
        model.inputModalities ?? null,
        model.outputModalities ?? null,
        model.contextWindow ?? null,
        model.maxOutputTokens ?? null,
        model.supportsFunctionCalling ?? model.supportsTools ?? null,
        model.supportsReasoning ?? null,
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
            input_modalities = case when $3::boolean then $4::text[] else input_modalities end,
            output_modalities = case when $5::boolean then $6::text[] else output_modalities end,
            context_window = case when $7::boolean then $8::integer else context_window end,
            max_output_tokens = case when $9::boolean then $10::integer else max_output_tokens end,
            supports_function_calling = case when $11::boolean then $12::boolean else supports_function_calling end,
            supports_reasoning = case when $13::boolean then $14::boolean else supports_reasoning end,
            supports_streaming = coalesce($15::boolean, supports_streaming),
            capability_metadata = (
              capability_metadata
              - 'syncedCapabilities'
              - 'conflicts'
              - 'tools'
              - 'reasoning'
              - 'reasoningLevels'
              - 'reasoningDefaultLevel'
              - 'outputTokenLimit'
              - 'registrySources'
              - 'registrySyncedAt'
              - 'streamingInferred'
            ) || $16::jsonb,
            updated_at = now()
        where id = $1
          and deleted_at is null
      `,
      [
        model.id,
        model.displayName,
        hasCapabilityUpdate(model, "inputModalities"),
        model.inputModalities ?? null,
        hasCapabilityUpdate(model, "outputModalities"),
        model.outputModalities ?? null,
        hasCapabilityUpdate(model, "maxContextTokens"),
        model.contextWindow ?? null,
        hasCapabilityUpdate(model, "maxOutputTokens"),
        model.maxOutputTokens ?? null,
        hasCapabilityUpdate(model, "supportsFunctionCalling"),
        model.supportsFunctionCalling ?? model.supportsTools ?? null,
        hasCapabilityUpdate(model, "supportsReasoning"),
        model.supportsReasoning ?? null,
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

function hasCapabilityUpdate(
  model: ListedProviderModel,
  field: keyof SyncedModelCapabilities,
): boolean {
  const metadata = readCapabilityMetadata(model.capabilityMetadata);
  return (
    metadata.syncedCapabilities?.[field] !== undefined ||
    metadata.manualCapabilities?.[field] !== undefined
  );
}

function readModelRefreshPayload(payload: unknown): { providerId: string } {
  if (isRecord(payload) && typeof payload.providerId === "string" && payload.providerId.trim()) {
    return { providerId: payload.providerId };
  }
  throw new Error("model_refresh job payload requires providerId.");
}

async function readProviderApiKey(input: {
  databaseUrl?: string;
  encryptionKeySource: EncryptionKeySource;
  providerId: string;
}): Promise<{ plaintext: string; snapshot: ProviderCredentialSnapshot }> {
  const stored = await withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<{ encrypted_key: unknown; id: string }>(
      `
        select id::text, encrypted_key
        from provider_api_keys
        where provider_id = $1
          and enabled = true
          and deleted_at is null
        order by priority, created_at, id
        limit 1
      `,
      [input.providerId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Provider API key was not found.");
    }
    return { encryptedKey: readEncryptedSecret(row.encrypted_key), id: row.id };
  });
  return {
    plaintext: createSecretEncryption(input.encryptionKeySource).decrypt(stored.encryptedKey),
    snapshot: { encryptedSecret: stored.encryptedKey, id: stored.id, kind: "api_key" },
  };
}

async function readProviderOAuthAccessToken(input: {
  databaseUrl?: string;
  fetch: typeof globalThis.fetch;
  encryptionKeySource: EncryptionKeySource;
  providerId: string;
  providerKey: string;
}): Promise<{ plaintext: string; snapshot: ProviderCredentialSnapshot }> {
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

  const encryption = createSecretEncryption(input.encryptionKeySource);
  const token = readProviderOAuthTokenBlob(
    encryption.decrypt(readEncryptedSecret(connection.encryptedToken)),
  );
  if (!isProviderOAuthTokenExpired(token)) {
    return {
      plaintext: token.accessToken,
      snapshot: {
        encryptedSecret: connection.encryptedToken,
        id: connection.id,
        kind: "oauth",
      },
    };
  }
  if (!token.refreshToken) {
    throw new Error("Provider OAuth token expired and has no refresh token.");
  }

  const refreshed = await refreshProviderOAuthToken({
    fetch: input.fetch,
    providerKey: input.providerKey,
    refreshToken: token.refreshToken,
  });
  const encryptedToken = encryption.encrypt(JSON.stringify(refreshed));
  await completeProviderOAuthConnection({
    databaseUrl: input.databaseUrl,
    encryptedToken,
    providerOAuthId: connection.id,
    tokenExpiresAt: refreshed.expiresAt === null ? null : new Date(refreshed.expiresAt),
  });
  return {
    plaintext: refreshed.accessToken,
    snapshot: { encryptedSecret: encryptedToken, id: connection.id, kind: "oauth" },
  };
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
