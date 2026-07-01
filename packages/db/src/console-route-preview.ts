import {
  type ManualPriceOverride,
  resolveEffectiveModelTokenPrice,
  type SyncedPriceSnapshot,
} from "@llmingress/billing/price-registry";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/client";
import {
  normalizeProviderModelCapabilities,
  normalizeRoutePolicyRules,
  type RouteCandidate,
  type RouteDecision,
  type RoutePolicy,
  type RouteTaskType,
  routeTaskTypes,
  selectRouteCandidate,
} from "@llmingress/domain";

export type RoutePreviewInput = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  taskType?: RouteTaskType;
  usesTools: boolean;
  virtualModelId?: string;
  virtualModelName?: string;
};

export type RoutePreviewResult = {
  candidates: RouteDecision["routeReason"]["candidateExplanations"];
  decision: RouteDecision;
  input: RoutePreviewInput;
};

type RoutePreviewRow = PostgresQueryResultRow & {
  cachedInputUsdPerMillionTokens: string | null;
  candidateOrder: number;
  capabilityMetadata: unknown;
  contextWindow: number | null;
  displayName: string;
  id: string;
  inputUsdPerMillionTokens: string | null;
  modelId: string;
  outputUsdPerMillionTokens: string | null;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  rules: unknown;
  strategy: RoutePolicy["strategy"];
  supportsTools: boolean;
  syncedAt: Date | null;
  syncedCachedInputUsdPerMillionTokens: string | null;
  syncedInputUsdPerMillionTokens: string | null;
  syncedOutputUsdPerMillionTokens: string | null;
  syncedPriceVersion: string | null;
  syncedSourceUrl: string | null;
  updatedAt: Date | null;
  virtualModelId: string;
  virtualModelName: string;
};

export async function previewRoutePolicy(input: {
  databaseUrl?: string;
  request: unknown;
}): Promise<RoutePreviewResult> {
  const normalized = normalizeRoutePreviewInput(input.request);
  const routePolicies = await loadRoutePreviewPolicies(input.databaseUrl);
  const decision = selectRouteCandidate({
    ...normalized,
    snapshot: { routePolicies },
  });

  return {
    candidates: decision.routeReason.candidateExplanations,
    decision,
    input: normalized,
  };
}

export function normalizeRoutePreviewInput(input: unknown): RoutePreviewInput {
  if (!isRecord(input)) {
    throw new Error("Route preview request must be a JSON object.");
  }

  const virtualModelId = readOptionalText(input.virtualModelId, "virtualModelId");
  const virtualModelName = readOptionalText(input.virtualModelName, "virtualModelName");
  if (!virtualModelId && !virtualModelName) {
    throw new Error("Route preview requires virtualModelId or virtualModelName.");
  }

  return omitUndefined({
    estimatedInputTokens: readNonNegativeFiniteNumber(
      input.estimatedInputTokens,
      "estimatedInputTokens",
    ),
    estimatedOutputTokens: readNonNegativeFiniteNumber(
      input.estimatedOutputTokens,
      "estimatedOutputTokens",
    ),
    taskType: readOptionalTaskType(input.taskType),
    usesTools: readBoolean(input.usesTools, "usesTools"),
    virtualModelId,
    virtualModelName,
  });
}

async function loadRoutePreviewPolicies(databaseUrl?: string): Promise<RoutePolicy[]> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<RoutePreviewRow>(
      `
        select route_policies.id::text as id,
               route_policies.strategy,
               route_policies.rules,
               virtual_models.id::text as "virtualModelId",
               virtual_models.name as "virtualModelName",
               route_policy_candidates.provider_model_id::text as "providerModelId",
               route_policy_candidates.candidate_order as "candidateOrder",
               provider_models.model_id as "modelId",
               provider_models.display_name as "displayName",
               provider_models.context_window as "contextWindow",
               provider_models.supports_tools as "supportsTools",
               provider_models.capability_metadata as "capabilityMetadata",
               providers.id::text as "providerId",
               providers.provider_key as "providerKey",
               provider_models.manual_input_usd_per_million_tokens::text
                 as "inputUsdPerMillionTokens",
               provider_models.manual_cached_input_usd_per_million_tokens::text
                 as "cachedInputUsdPerMillionTokens",
               provider_models.manual_output_usd_per_million_tokens::text
                 as "outputUsdPerMillionTokens",
               provider_models.manual_price_updated_at as "updatedAt",
               provider_models.synced_input_usd_per_million_tokens::text
                 as "syncedInputUsdPerMillionTokens",
               provider_models.synced_cached_input_usd_per_million_tokens::text
                 as "syncedCachedInputUsdPerMillionTokens",
               provider_models.synced_output_usd_per_million_tokens::text
                 as "syncedOutputUsdPerMillionTokens",
               provider_models.synced_price_version
                 as "syncedPriceVersion",
               provider_models.synced_price_source_url
                 as "syncedSourceUrl",
               provider_models.synced_price_synced_at
                 as "syncedAt"
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
        join route_policy_candidates
          on route_policy_candidates.route_policy_id = route_policies.id
        join provider_models on provider_models.id = route_policy_candidates.provider_model_id
        join providers on providers.id = provider_models.provider_id
        where virtual_models.enabled = true
          and virtual_models.deleted_at is null
          and route_policies.deleted_at is null
          and providers.enabled = true
          and providers.deleted_at is null
          and provider_models.deleted_at is null
          and provider_models.availability = 'available'
        order by virtual_models.name,
                 route_policies.id,
                 route_policy_candidates.candidate_order
      `,
    );

    return rowToRoutePolicies(result.rows);
  } finally {
    await client.end();
  }
}

function rowToRoutePolicies(rows: RoutePreviewRow[]): RoutePolicy[] {
  const routePolicies = new Map<string, RoutePolicy>();

  for (const row of rows) {
    let routePolicy = routePolicies.get(row.id);
    if (!routePolicy) {
      routePolicy = {
        candidates: [],
        id: row.id,
        rules: normalizeRoutePolicyRules(row.rules),
        strategy: row.strategy,
        virtualModelId: row.virtualModelId,
        virtualModelName: row.virtualModelName,
      };
      routePolicies.set(row.id, routePolicy);
    }

    routePolicy.candidates.push(rowToRouteCandidate(row));
  }

  return [...routePolicies.values()];
}

function rowToRouteCandidate(row: RoutePreviewRow): RouteCandidate {
  return {
    candidateOrder: row.candidateOrder,
    capabilities: normalizeProviderModelCapabilities(row.capabilityMetadata),
    contextWindow: row.contextWindow,
    displayName: row.displayName,
    modelId: row.modelId,
    price: resolveEffectiveModelTokenPrice({
      manualOverride: rowToManualPriceOverride(row),
      modelId: row.modelId,
      providerKey: row.providerKey,
      syncedPrice: rowToSyncedPriceSnapshot(row),
    }),
    providerId: row.providerId,
    providerKey: row.providerKey,
    providerModelId: row.providerModelId,
    supportsTools: row.supportsTools,
  };
}

function rowToManualPriceOverride(row: RoutePreviewRow): ManualPriceOverride | null {
  if (
    row.inputUsdPerMillionTokens === null ||
    row.outputUsdPerMillionTokens === null ||
    row.updatedAt === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.cachedInputUsdPerMillionTokens === null
        ? null
        : Number(row.cachedInputUsdPerMillionTokens),
    inputUsdPerMillionTokens: Number(row.inputUsdPerMillionTokens),
    modelId: row.modelId,
    outputUsdPerMillionTokens: Number(row.outputUsdPerMillionTokens),
    providerKey: row.providerKey,
    updatedAt: row.updatedAt,
  };
}

function rowToSyncedPriceSnapshot(row: RoutePreviewRow): SyncedPriceSnapshot | null {
  if (
    row.syncedInputUsdPerMillionTokens === null ||
    row.syncedOutputUsdPerMillionTokens === null ||
    row.syncedPriceVersion === null ||
    row.syncedAt === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.syncedCachedInputUsdPerMillionTokens === null
        ? null
        : Number(row.syncedCachedInputUsdPerMillionTokens),
    inputUsdPerMillionTokens: Number(row.syncedInputUsdPerMillionTokens),
    modelId: row.modelId,
    outputUsdPerMillionTokens: Number(row.syncedOutputUsdPerMillionTokens),
    priceVersion: row.syncedPriceVersion,
    providerKey: row.providerKey,
    sourceUrl: row.syncedSourceUrl,
    syncedAt: row.syncedAt,
  };
}

function readOptionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function readNonNegativeFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function readOptionalTaskType(value: unknown): RouteTaskType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!routeTaskTypes.includes(value as RouteTaskType)) {
    throw new Error("taskType must be a valid route task type.");
  }
  return value as RouteTaskType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
