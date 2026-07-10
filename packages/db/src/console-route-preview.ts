import { resolveEffectiveModelTokenPrice } from "@llmingress/billing/price-registry";
import { PostgresClient } from "@llmingress/db/client";
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
import { z } from "zod";
import { consoleValidationError } from "./console-operation-error.ts";
import { buildManualPriceOverride, buildSyncedPriceSnapshot } from "./price-rows.ts";

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

type RoutePreviewRow = {
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

const routePreviewInputSchema = z.object({
  virtualModelId: optionalNonEmptyText("virtualModelId"),
  virtualModelName: optionalNonEmptyText("virtualModelName"),
  estimatedInputTokens: nonNegativeFiniteNumber("estimatedInputTokens"),
  estimatedOutputTokens: nonNegativeFiniteNumber("estimatedOutputTokens"),
  taskType: optionalRouteTaskType(),
  usesTools: z.custom<boolean>((value) => typeof value === "boolean", {
    message: "usesTools must be a boolean.",
  }),
});

export function normalizeRoutePreviewInput(input: unknown): RoutePreviewInput {
  if (!isRecord(input)) {
    throw consoleValidationError(
      "Route preview request must be a JSON object.",
      "route_preview_invalid",
    );
  }
  if (
    (input.virtualModelId === undefined || input.virtualModelId === null) &&
    (input.virtualModelName === undefined || input.virtualModelName === null)
  ) {
    throw consoleValidationError(
      "Route preview requires virtualModelId or virtualModelName.",
      "route_preview_missing_virtual_model",
    );
  }

  const parsed = routePreviewInputSchema.safeParse(input);
  if (!parsed.success) {
    throw consoleValidationError(
      parsed.error.issues[0]?.message ?? "Route preview request is invalid.",
      "route_preview_invalid",
    );
  }
  return omitUndefined(parsed.data);
}

function nonNegativeFiniteNumber(name: string) {
  return z.custom<number>(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    { message: `${name} must be a non-negative finite number.` },
  );
}

function optionalNonEmptyText(name: string) {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z
      .custom<string>((value) => typeof value === "string" && value.trim() !== "", {
        message: `${name} must be a non-empty string.`,
      })
      .transform((value) => value.trim())
      .optional(),
  );
}

function optionalRouteTaskType() {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    z
      .custom<RouteTaskType>((value) => routeTaskTypes.includes(value as RouteTaskType), {
        message: "taskType must be a valid route task type.",
      })
      .optional(),
  );
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
      manualOverride: buildManualPriceOverride({
        cachedInputUsdPerMillionTokens: row.cachedInputUsdPerMillionTokens,
        inputUsdPerMillionTokens: row.inputUsdPerMillionTokens,
        modelId: row.modelId,
        outputUsdPerMillionTokens: row.outputUsdPerMillionTokens,
        providerKey: row.providerKey,
        updatedAt: row.updatedAt,
      }),
      modelId: row.modelId,
      providerKey: row.providerKey,
      syncedPrice: buildSyncedPriceSnapshot({
        cachedInputUsdPerMillionTokens: row.syncedCachedInputUsdPerMillionTokens,
        inputUsdPerMillionTokens: row.syncedInputUsdPerMillionTokens,
        modelId: row.modelId,
        outputUsdPerMillionTokens: row.syncedOutputUsdPerMillionTokens,
        priceVersion: row.syncedPriceVersion,
        providerKey: row.providerKey,
        sourceUrl: row.syncedSourceUrl,
        syncedAt: row.syncedAt,
      }),
    }),
    providerId: row.providerId,
    providerKey: row.providerKey,
    providerModelId: row.providerModelId,
    supportsTools: row.supportsTools,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
