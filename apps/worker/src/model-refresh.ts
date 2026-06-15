import { randomUUID } from "node:crypto";
import { type ConfigChange, createConfigPublisher } from "@llmingress/config";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { Client, type QueryResultRow } from "pg";
import type { JobHandler } from "./job-runner.js";

export type ProviderModelAvailability = "available" | "unavailable" | "not_listed" | "deprecated";

export type ListedProviderModel = {
  displayName: string;
  modelId: string;
};

export type ExistingProviderModel = {
  availability: ProviderModelAvailability;
  displayName: string;
  id: string;
  modelId: string;
  referenced: boolean;
};

export type ProviderModelRefreshPlan = {
  insertModels: ListedProviderModel[];
  markAvailable: Array<ListedProviderModel & { id: string; referenced: boolean }>;
  markNotListed: Array<{ id: string; modelId: string; referenced: false }>;
  markUnavailable: Array<{ id: string; modelId: string; referenced: true }>;
  routingVisibleChanges: ConfigChange[];
};

export type ProviderModelRefreshResult = {
  fetchedModelCount: number;
  insertedModelCount: number;
  markedAvailableCount: number;
  markedNotListedCount: number;
  markedUnavailableCount: number;
  providerId: string;
  publishedConfigVersion: number | null;
  routingVisibleChangeCount: number;
};

type CreateModelRefreshJobHandlerOptions = {
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  masterKeySource?: MasterKeySource;
};

type RefreshProviderModelsOptions = CreateModelRefreshJobHandlerOptions & {
  providerId: string;
};

type PlanProviderModelRefreshInput = {
  existingModels: ExistingProviderModel[];
  listedModels: ListedProviderModel[];
};

type ProviderRow = QueryResultRow & {
  base_url: string | null;
  display_name: string;
  id: string;
  provider_key: string;
  provider_type: "api_key" | "local";
};

type ProviderModelRow = QueryResultRow & {
  availability: ProviderModelAvailability;
  display_name: string;
  id: string;
  model_id: string;
  referenced: boolean;
};

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
      if (existing.availability !== "available" || existing.displayName !== listed.displayName) {
        markAvailable.push({
          displayName: listed.displayName,
          id: existing.id,
          modelId: listed.modelId,
          referenced: existing.referenced,
        });

        if (existing.referenced && existing.availability !== "available") {
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
      : null;
  const listedModels = await fetchListedProviderModels(fetchImpl, provider, apiKey);
  const existingModels = await readExistingProviderModels(options.databaseUrl, provider.id);
  const plan = planProviderModelRefresh({ existingModels, listedModels });
  const writePlan = (client: QueryClient) =>
    applyProviderModelRefreshPlan(client, provider.id, plan);
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
    await withClient(options.databaseUrl, async (client) => {
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
    fetchedModelCount: listedModels.length,
    insertedModelCount: plan.insertModels.length,
    markedAvailableCount: plan.markAvailable.length,
    markedNotListedCount: plan.markNotListed.length,
    markedUnavailableCount: plan.markUnavailable.length,
    providerId: provider.id,
    publishedConfigVersion,
    routingVisibleChangeCount: plan.routingVisibleChanges.length,
  };
}

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

async function readProvider(databaseUrl: string, providerId: string): Promise<ProviderRow> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderRow>(
      `
        select id::text, provider_type, provider_key, display_name, base_url
        from providers
        where id = $1
          and enabled = true
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
  databaseUrl: string,
  providerId: string,
): Promise<ExistingProviderModel[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderModelRow>(
      `
        select provider_models.id::text,
               provider_models.model_id,
               provider_models.display_name,
               provider_models.availability,
               exists (
                 select 1
                 from route_policy_candidates
                 where route_policy_candidates.provider_model_id = provider_models.id
               ) as referenced
        from provider_models
        where provider_models.provider_id = $1
        order by provider_models.model_id
      `,
      [providerId],
    );

    return result.rows.map((row) => ({
      availability: row.availability,
      displayName: row.display_name,
      id: row.id,
      modelId: row.model_id,
      referenced: row.referenced,
    }));
  });
}

async function fetchListedProviderModels(
  fetchImpl: typeof globalThis.fetch,
  provider: ProviderRow,
  apiKey: string | null,
): Promise<ListedProviderModel[]> {
  const request = buildProviderModelListRequest({
    apiKey,
    baseUrl: provider.base_url as string,
  });
  const response = await fetchImpl(request.url, request.init);
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Provider model list request failed with status ${response.status}.`);
  }

  return parseProviderModelList(body);
}

export function buildProviderModelListRequest(input: { apiKey?: string | null; baseUrl: string }): {
  init: RequestInit;
  url: string;
} {
  const init: RequestInit = { method: "GET" };

  if (input.apiKey) {
    init.headers = {
      authorization: `Bearer ${input.apiKey}`,
    };
  }

  return {
    init,
    url: buildModelsUrl(input.baseUrl),
  };
}

function parseProviderModelList(body: unknown): ListedProviderModel[] {
  if (isRecord(body) && Array.isArray(body.data)) {
    return body.data
      .map((entry): ListedProviderModel | null => {
        if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
          return {
            displayName:
              typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
            modelId: entry.id,
          };
        }
        return null;
      })
      .filter((entry): entry is ListedProviderModel => entry !== null);
  }

  if (isRecord(body) && Array.isArray(body.models)) {
    return body.models
      .map((entry): ListedProviderModel | null => {
        if (isRecord(entry) && typeof entry.name === "string" && entry.name.trim()) {
          return {
            displayName: entry.name,
            modelId: entry.name,
          };
        }
        return null;
      })
      .filter((entry): entry is ListedProviderModel => entry !== null);
  }

  throw new Error("Provider model list response was not recognized.");
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
          availability
        )
        values ($1, $2, $3, $4, 'available')
        on conflict (provider_id, model_id) do update
        set display_name = excluded.display_name,
            availability = 'available',
            updated_at = now()
      `,
      [randomUUID(), providerId, model.modelId, model.displayName],
    );
  }

  for (const model of plan.markAvailable) {
    await client.query(
      `
        update provider_models
        set display_name = $2,
            availability = 'available',
            updated_at = now()
        where id = $1
      `,
      [model.id, model.displayName],
    );
  }

  for (const model of plan.markUnavailable) {
    await client.query(
      `
        update provider_models
        set availability = 'unavailable',
            updated_at = now()
        where id = $1
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
  const encrypted = await withClient(input.databaseUrl, async (client) => {
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

  throw new Error("Stored provider API key is not a valid encrypted secret.");
}

function buildModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/models`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withClient<T>(
  databaseUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
