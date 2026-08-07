import { randomUUID } from "node:crypto";
import {
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import { listProviderRouteEndpointProtocols as listRegistryRouteEndpointProtocols } from "@llmingress/config/provider-registry";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import {
  isValidRouteTag,
  type ModelInputModality,
  type ModelOutputModality,
  normalizeRouteTag,
  type ProviderModelCapabilityMetadata,
  ROUTE_TAG_DEFAULT,
  type RouteEndpointProtocol,
  resolveVirtualModelCapabilityContract,
  routeEndpointProtocols,
  routeStrategyCapabilityContractScope,
} from "@llmingress/domain";
import {
  consoleConflictError,
  consoleNotFoundError,
  consoleValidationError,
} from "./console-operation-error.ts";
import { consoleVisibleProviderModelFilterSql } from "./console-provider-model-visibility.ts";
import { lockProvidersForProviderModels } from "./console-providers.ts";
import { buildManualPriceOverride, buildSyncedPriceSnapshot } from "./price-rows.ts";

export const routePolicyStrategies = [
  "fixed",
  "cost_first",
  "load_balance",
  "tag",
  "weighted",
  "least_time",
] as const;

export type RoutePolicyStrategy = (typeof routePolicyStrategies)[number];

export type RoutePolicyFormInput = {
  /** One comma-separated tag list per candidate, in the candidate order. */
  candidateTags?: readonly (string | null | undefined)[];
  /** One weight per candidate, in the candidate order; only weighted reads them. */
  candidateWeights?: readonly (string | null | undefined)[];
  endpointProtocol?: string | null;
  providerModelIds?: readonly (string | null | undefined)[];
  strategy?: string | null;
  virtualModelId?: string | null;
};

export type NormalizedRoutePolicyFormInput = {
  /** Always one entry per candidate; empty lists for strategies that ignore tags. */
  candidateTags: string[][];
  /** Always one entry per candidate; null entries for strategies that ignore weights. */
  candidateWeights: (number | null)[];
  endpointProtocol: RouteEndpointProtocol;
  providerModelIds: string[];
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
};

export type TagRouteCoverageCandidate = {
  contextWindow: number | null;
  inputModalities: ModelInputModality[] | null;
  maxOutputTokens: number | null;
  optionLabel: string;
  outputModalities: ModelOutputModality[] | null;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  tags: readonly string[];
};

export type ConsoleProviderModelOption = {
  availability: string;
  capabilityMetadata: ProviderModelCapabilityMetadata;
  contextWindow: number | null;
  id: string;
  inputModalities: ModelInputModality[] | null;
  maxOutputTokens: number | null;
  modelDisplayName: string;
  modelId: string;
  optionLabel: string;
  outputModalities: ModelOutputModality[] | null;
  pricedOptionLabel: string;
  priceStatus: ModelTokenPrice["status"];
  priceStatusLabel: string;
  /** Effective input price (manual override > synced > built-in); null when unknown. */
  inputUsdPerMillionTokens: number | null;
  /** Effective output price; null when unknown. */
  outputUsdPerMillionTokens: number | null;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
  providerEnabled: boolean;
  supportedEndpoints: RouteEndpointProtocol[];
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  supportsStreaming: boolean;
};

export type ConsoleRoutePolicyCandidate = ConsoleProviderModelOption & {
  candidateOrder: number;
  tags: string[];
  /** Two-decimal fraction of primary traffic; null when the strategy is not weighted. */
  weight: number | null;
};

export type ConsoleRoutePolicy = {
  candidates: ConsoleRoutePolicyCandidate[];
  endpointProtocol: RouteEndpointProtocol | null;
  id: string;
  routeReason: string;
  routeWarnings: string[];
  strategy: RoutePolicyStrategy;
  virtualModelDisplayName: string;
  virtualModelId: string;
  virtualModelName: string;
};

export type ConsoleProviderModelPage = {
  items: ConsoleProviderModelOption[];
  page: number;
  pageCount: number;
  total: number;
};

export type RoutePolicyWarningCandidate = {
  availability: string;
  optionLabel: string;
  priceStatus?: ModelTokenPrice["status"];
};

export type RoutePolicyEditorFilterInput = {
  endpointProtocol?: string | null;
  modelQuery?: string | null;
  providerKey?: string | null;
};

export type RoutePolicyEditorFilters = {
  endpointProtocol: RouteEndpointProtocol | null;
  modelQuery: string | null;
  providerKey: string | null;
};

export type RoutePolicyConnectionHealthWarningCandidate = {
  allConnectionsUnhealthy: boolean;
  optionLabel: string;
};

export type RouteReasonMetadataInput = {
  candidateCount: number;
  strategy: RoutePolicyStrategy;
  virtualModelName: string;
};

type RoutePolicyRow = {
  endpoint_protocol: RouteEndpointProtocol;
  id: string;
  strategy: RoutePolicyStrategy;
  virtual_model_display_name: string;
  virtual_model_id: string;
  virtual_model_name: string;
};

type CandidateRow = {
  availability: string;
  capability_metadata?: unknown;
  candidate_order: number;
  context_window?: number | null;
  id: string;
  input_modalities?: ModelInputModality[] | null;
  max_output_tokens?: number | null;
  model_display_name: string;
  model_id: string;
  output_modalities?: ModelOutputModality[] | null;
  price_override_cached_input_usd_per_million_tokens: string | null;
  price_override_input_usd_per_million_tokens: string | null;
  price_override_output_usd_per_million_tokens: string | null;
  price_override_updated_at: Date | null;
  price_sync_cached_input_usd_per_million_tokens: string | null;
  price_sync_input_usd_per_million_tokens: string | null;
  price_sync_output_usd_per_million_tokens: string | null;
  price_sync_price_version: string | null;
  price_sync_source_url: string | null;
  price_sync_synced_at: Date | null;
  provider_display_name: string;
  provider_enabled: boolean;
  provider_id: string;
  provider_key: string;
  provider_template_id: string | null;
  route_policy_id: string;
  supports_function_calling?: boolean | null;
  supports_reasoning?: boolean | null;
  supports_streaming?: boolean | null;
  tags?: string[] | null;
  weight?: string | null;
};

type ProviderModelOptionRow = {
  availability: string;
  capability_metadata?: unknown;
  context_window?: number | null;
  id: string;
  input_modalities?: ModelInputModality[] | null;
  max_output_tokens?: number | null;
  model_display_name: string;
  model_id: string;
  output_modalities?: ModelOutputModality[] | null;
  price_override_cached_input_usd_per_million_tokens: string | null;
  price_override_input_usd_per_million_tokens: string | null;
  price_override_output_usd_per_million_tokens: string | null;
  price_override_updated_at: Date | null;
  price_sync_cached_input_usd_per_million_tokens: string | null;
  price_sync_input_usd_per_million_tokens: string | null;
  price_sync_output_usd_per_million_tokens: string | null;
  price_sync_price_version: string | null;
  price_sync_source_url: string | null;
  price_sync_synced_at: Date | null;
  provider_display_name: string;
  provider_enabled: boolean;
  provider_id: string;
  provider_key: string;
  provider_template_id: string | null;
  supports_function_calling?: boolean | null;
  supports_reasoning?: boolean | null;
  supports_streaming?: boolean | null;
};

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export function normalizeRoutePolicyFormInput(
  input: RoutePolicyFormInput,
): NormalizedRoutePolicyFormInput {
  const endpointProtocol = normalizeRequiredEndpointProtocol(input.endpointProtocol);
  const virtualModelId = input.virtualModelId?.trim();
  const strategy = input.strategy?.trim();
  const providerModelIds = normalizeUuidList(input.providerModelIds);

  if (!virtualModelId || !isUuid(virtualModelId)) {
    throw consoleValidationError(
      "Route policy virtual model is required.",
      "route_policy_virtual_model_required",
      { field: "virtualModelId" },
    );
  }
  if (!isRoutePolicyStrategy(strategy)) {
    throw consoleValidationError(
      `Route policy strategy must be one of ${routePolicyStrategies.join(", ")}.`,
      "route_policy_strategy_invalid",
      { field: "strategy" },
    );
  }
  if (providerModelIds.length === 0) {
    throw consoleValidationError(
      "Route policy requires at least one provider model.",
      "route_policy_candidates_required",
      { field: "providerModelIds" },
    );
  }

  if (new Set(providerModelIds).size !== providerModelIds.length) {
    throw consoleValidationError(
      "Route policy candidates must not contain duplicate provider models.",
      "route_policy_candidates_duplicate",
      { field: "providerModelIds" },
    );
  }

  return {
    candidateTags: normalizeRoutePolicyCandidateTags({
      candidateTags: input.candidateTags,
      providerModelIds,
      strategy,
    }),
    candidateWeights: normalizeRoutePolicyCandidateWeights({
      candidateWeights: input.candidateWeights,
      providerModelIds,
      strategy,
    }),
    endpointProtocol,
    providerModelIds,
    strategy,
    virtualModelId,
  };
}

/**
 * Cross-candidate tag rules live here rather than in the schema: candidates are
 * rewritten as one transaction holding the policy row lock, so there is no
 * window for a second writer to slip a duplicate tag or a second default past
 * this check.
 */
function normalizeRoutePolicyCandidateTags(input: {
  candidateTags?: readonly (string | null | undefined)[];
  providerModelIds: readonly string[];
  strategy: RoutePolicyStrategy;
}): string[][] {
  if (input.strategy !== "tag") {
    return input.providerModelIds.map(() => []);
  }

  const seenTags = new Map<string, string>();
  const candidateTags = input.providerModelIds.map((providerModelId, index) => {
    const tags: string[] = [];
    for (const rawTag of (input.candidateTags?.[index] ?? "").split(",")) {
      const tag = normalizeRouteTag(rawTag);
      if (!tag) {
        continue;
      }
      if (!isValidRouteTag(tag)) {
        throw consoleValidationError(
          `Route tag ${tag} must start with a letter or digit and use only letters, digits, dot, dash, or underscore.`,
          "route_policy_tag_invalid",
          { field: "candidateTags", providerModelId, tag },
        );
      }
      const owner = seenTags.get(tag);
      if (owner && owner !== providerModelId) {
        throw consoleValidationError(
          `Route tag ${tag} is on more than one candidate; a tag names exactly one candidate.`,
          "route_policy_tag_duplicate",
          { field: "candidateTags", providerModelId, tag },
        );
      }
      seenTags.set(tag, providerModelId);
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }

    if (tags.length === 0) {
      throw consoleValidationError(
        "Every candidate of a tag route needs at least one tag; an untagged candidate can never be reached.",
        "route_policy_tag_missing",
        { field: "candidateTags", providerModelId },
      );
    }

    return tags;
  });

  if (!candidateTags.some((tags) => tags.includes(ROUTE_TAG_DEFAULT))) {
    throw consoleValidationError(
      `Exactly one candidate must carry the ${ROUTE_TAG_DEFAULT} tag; it serves requests with no tag or an unknown one.`,
      "route_policy_tag_default_required",
      { field: "candidateTags" },
    );
  }

  return candidateTags;
}

/** Exactly up to two decimals between 0 and 1: "0", "1", "0.2", "0.20", "1.00". */
const routePolicyWeightPattern = /^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/;

/**
 * The cross-candidate weight rule (the weights of one policy sum to exactly
 * 1.00) lives here rather than in the schema: candidates are rewritten as one
 * transaction holding the policy row lock, so there is no window for a second
 * writer to unbalance the sum. The sum is checked on integer hundredths -
 * two-decimal weights are exact there, while floating point would refuse
 * 0.10 + 0.20 + 0.70.
 */
function normalizeRoutePolicyCandidateWeights(input: {
  candidateWeights?: readonly (string | null | undefined)[];
  providerModelIds: readonly string[];
  strategy: RoutePolicyStrategy;
}): (number | null)[] {
  if (input.strategy !== "weighted") {
    return input.providerModelIds.map(() => null);
  }

  let sumHundredths = 0;
  const candidateWeights = input.providerModelIds.map((providerModelId, index) => {
    const raw = (input.candidateWeights?.[index] ?? "").trim();
    if (!raw) {
      throw consoleValidationError(
        "Every candidate of a weighted route needs a weight; a 0.00 weight keeps it as a fallback-only candidate.",
        "route_policy_weight_missing",
        { field: "candidateWeights", providerModelId },
      );
    }
    if (!routePolicyWeightPattern.test(raw)) {
      throw consoleValidationError(
        `Route weight ${raw} must be a decimal between 0 and 1 with at most two decimal places, like 0.25.`,
        "route_policy_weight_invalid",
        { field: "candidateWeights", providerModelId, weight: raw },
      );
    }
    const hundredths = Math.round(Number(raw) * 100);
    sumHundredths += hundredths;
    return hundredths / 100;
  });

  if (sumHundredths !== 100) {
    throw consoleValidationError(
      `Route weights must sum to exactly 1.00; these sum to ${(sumHundredths / 100).toFixed(2)}.`,
      "route_policy_weight_sum_invalid",
      { field: "candidateWeights" },
    );
  }

  return candidateWeights;
}

/**
 * A tag route deliberately mixes unequal candidates, so the default candidate is
 * not required to cover the others — but a request sized for a tagged candidate
 * fails on fallback when it does not. Unknown values are left alone: they are
 * missing metadata, not a narrower model.
 */
export function buildTagRouteCoverageWarnings(
  candidates: readonly TagRouteCoverageCandidate[],
): string[] {
  const defaultCandidate = candidates.find((candidate) =>
    candidate.tags.includes(ROUTE_TAG_DEFAULT),
  );
  if (!defaultCandidate) {
    return [];
  }

  const warnings: string[] = [];
  for (const candidate of candidates) {
    if (candidate === defaultCandidate) {
      continue;
    }

    warnings.push(
      ...tagCoverageCeilingWarning({
        candidate,
        candidateValue: candidate.contextWindow,
        defaultCandidate,
        defaultValue: defaultCandidate.contextWindow,
        label: "context window",
      }),
      ...tagCoverageCeilingWarning({
        candidate,
        candidateValue: candidate.maxOutputTokens,
        defaultCandidate,
        defaultValue: defaultCandidate.maxOutputTokens,
        label: "max output tokens",
      }),
      ...tagCoverageModalityWarning({
        candidate,
        candidateValue: candidate.inputModalities,
        defaultCandidate,
        defaultValue: defaultCandidate.inputModalities,
        label: "input modalities",
      }),
      ...tagCoverageModalityWarning({
        candidate,
        candidateValue: candidate.outputModalities,
        defaultCandidate,
        defaultValue: defaultCandidate.outputModalities,
        label: "output modalities",
      }),
      ...tagCoverageFeatureWarning({
        candidate,
        candidateValue: candidate.supportsFunctionCalling,
        defaultCandidate,
        defaultValue: defaultCandidate.supportsFunctionCalling,
        label: "function calling",
      }),
      ...tagCoverageFeatureWarning({
        candidate,
        candidateValue: candidate.supportsReasoning,
        defaultCandidate,
        defaultValue: defaultCandidate.supportsReasoning,
        label: "reasoning",
      }),
    );
  }

  return warnings;
}

function tagCoverageCeilingWarning(input: {
  candidate: TagRouteCoverageCandidate;
  candidateValue: number | null;
  defaultCandidate: TagRouteCoverageCandidate;
  defaultValue: number | null;
  label: string;
}): string[] {
  if (
    input.candidateValue === null ||
    input.defaultValue === null ||
    input.defaultValue >= input.candidateValue
  ) {
    return [];
  }

  return [
    `Tag coverage warning: ${input.candidate.optionLabel} allows ${input.label} ${input.candidateValue}, above ${input.defaultCandidate.optionLabel} at ${input.defaultValue}; a request sized for the tag fails after falling back to the default candidate.`,
  ];
}

function tagCoverageModalityWarning(input: {
  candidate: TagRouteCoverageCandidate;
  candidateValue: readonly string[] | null;
  defaultCandidate: TagRouteCoverageCandidate;
  defaultValue: readonly string[] | null;
  label: string;
}): string[] {
  if (input.candidateValue === null || input.defaultValue === null) {
    return [];
  }
  const defaultValue = input.defaultValue;
  const uncovered = input.candidateValue.filter((modality) => !defaultValue.includes(modality));
  if (uncovered.length === 0) {
    return [];
  }

  return [
    `Tag coverage warning: ${input.candidate.optionLabel} serves ${input.label} ${uncovered.join(", ")} that ${input.defaultCandidate.optionLabel} does not; such a request fails after falling back to the default candidate.`,
  ];
}

function tagCoverageFeatureWarning(input: {
  candidate: TagRouteCoverageCandidate;
  candidateValue: boolean | null;
  defaultCandidate: TagRouteCoverageCandidate;
  defaultValue: boolean | null;
  label: string;
}): string[] {
  if (input.candidateValue !== true || input.defaultValue !== false) {
    return [];
  }

  return [
    `Tag coverage warning: ${input.candidate.optionLabel} supports ${input.label} but ${input.defaultCandidate.optionLabel} does not; such a request fails after falling back to the default candidate.`,
  ];
}

export function buildRouteReasonMetadata(input: RouteReasonMetadataInput): string {
  const candidates = `${input.candidateCount} ${pluralize("candidate", input.candidateCount)}`;
  return `${input.strategy} route for ${input.virtualModelName} uses ${candidates}.`;
}

export function buildRoutePolicyWarnings(
  candidates: readonly RoutePolicyWarningCandidate[],
): string[] {
  const warnings: string[] = [];

  for (const candidate of candidates) {
    if (candidate.priceStatus === "unknown_price") {
      warnings.push(
        `Price warning: ${candidate.optionLabel} has unknown price and is tried after priced candidates.`,
      );
    }
    if (candidate.availability !== "available") {
      warnings.push(
        `Route warning: ${candidate.optionLabel} is ${candidate.availability} and excluded from Gateway routing.`,
      );
    }
  }

  return warnings;
}

export function buildRoutePolicyConnectionHealthWarnings(
  candidates: readonly RoutePolicyConnectionHealthWarningCandidate[],
): string[] {
  const warnings: string[] = [];

  for (const candidate of candidates) {
    if (candidate.allConnectionsUnhealthy) {
      warnings.push(
        `Health warning: ${candidate.optionLabel} has no healthy Provider connections.`,
      );
    }
  }

  return warnings;
}

export function normalizeRoutePolicyEditorFilters(
  input: RoutePolicyEditorFilterInput,
): RoutePolicyEditorFilters {
  return {
    endpointProtocol: normalizeOptionalEndpointProtocol(input.endpointProtocol),
    modelQuery: normalizeOptionalFilter(input.modelQuery),
    providerKey: normalizeOptionalFilter(input.providerKey),
  };
}

export function filterRoutePolicyEditorProviderModelOptions(
  options: readonly ConsoleProviderModelOption[],
  filters: RoutePolicyEditorFilters,
): ConsoleProviderModelOption[] {
  const providerKey = filters.providerKey?.toLowerCase() ?? null;
  const modelQuery = filters.modelQuery?.toLowerCase() ?? null;

  return options.filter((option) => {
    if (filters.endpointProtocol && !option.supportedEndpoints.includes(filters.endpointProtocol)) {
      return false;
    }
    if (providerKey && option.providerKey.toLowerCase() !== providerKey) {
      return false;
    }
    if (
      modelQuery &&
      ![
        option.modelDisplayName,
        option.modelId,
        option.providerDisplayName,
        option.providerKey,
      ].some((value) => value.toLowerCase().includes(modelQuery))
    ) {
      return false;
    }
    return true;
  });
}

export function listProviderRouteEndpointProtocols(providerKey: string): RouteEndpointProtocol[] {
  return listRegistryRouteEndpointProtocols(providerKey);
}

export function formatProviderModelPriceStatusLabel(price: ModelTokenPrice): string {
  if (price.status === "unknown_price") {
    return "Unknown price";
  }

  if (price.source === "manual_override") {
    return "Priced (manual override)";
  }
  return "Priced (price sync)";
}

export function formatProviderModelOptionLabel(input: {
  modelDisplayName: string;
  modelId: string;
  providerDisplayName: string;
}): string {
  return `${input.providerDisplayName} - ${input.modelDisplayName} (${input.modelId})`;
}

export function formatPricedProviderModelOptionLabel(input: {
  modelDisplayName: string;
  modelId: string;
  priceStatusLabel: string;
  providerDisplayName: string;
}): string {
  return `${formatProviderModelOptionLabel(input)} - ${input.priceStatusLabel}`;
}

export async function listProviderModelOptions(
  databaseUrl?: string,
): Promise<ConsoleProviderModelOption[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderModelOptionRow>(providerModelOptionsSql());
    return result.rows.map(rowToProviderModelOption);
  });
}

export async function listProviderModelPage(input: {
  availability?: string | null;
  databaseUrl?: string;
  page?: number;
  pageSize?: number;
  providerId: string;
  query?: string | null;
}): Promise<ConsoleProviderModelPage> {
  const requestedPage =
    Number.isInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : 1;
  const query = input.query?.trim() || null;
  // "all" is the absence of a filter, not a stored availability value.
  const availability =
    input.availability && input.availability !== "all" ? input.availability : null;
  const pageSize =
    Number.isInteger(input.pageSize) && Number(input.pageSize) > 0 ? Number(input.pageSize) : 50;

  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const values = [input.providerId, query, availability] as const;
    const filters = `
      provider_models.provider_id = $1::uuid
      and provider_models.deleted_at is null
      and providers.deleted_at is null
      and ${consoleVisibleProviderModelFilterSql}
      and (
        $2::text is null
        or provider_models.model_id ilike '%' || $2 || '%'
        or provider_models.display_name ilike '%' || $2 || '%'
      )
      and ($3::text is null or provider_models.availability = $3)
    `;
    const countResult = await client.query<{ total: number }>(
      `
        select count(*)::integer as total
        from provider_models
        join providers on providers.id = provider_models.provider_id
        where ${filters}
      `,
      values,
    );
    const total = countResult.rows[0]?.total ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const result = await client.query<ProviderModelOptionRow>(
      `
        ${providerModelOptionsSelectSql()}
        where ${filters}
        order by lower(provider_models.display_name), provider_models.model_id, provider_models.id
        limit $4
        offset $5
      `,
      [...values, pageSize, (page - 1) * pageSize],
    );

    return {
      items: result.rows.map(rowToProviderModelOption),
      page,
      pageCount,
      total,
    };
  });
}

export async function listRoutePolicies(databaseUrl?: string): Promise<ConsoleRoutePolicy[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const policies = await client.query<RoutePolicyRow>(
      `
        select route_policies.id::text,
               route_policies.strategy,
               route_policies.endpoint_protocol,
               virtual_models.id::text as virtual_model_id,
               virtual_models.name as virtual_model_name,
               virtual_models.description as virtual_model_display_name
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
        where route_policies.deleted_at is null
          and virtual_models.deleted_at is null
        order by virtual_models.name
      `,
    );
    const policyIds = policies.rows.map((policy) => policy.id);
    const candidateRows =
      policyIds.length === 0
        ? []
        : (
            await client.query<CandidateRow>(
              `
                select route_policy_candidates.route_policy_id::text,
                       provider_models.id::text as id,
                       providers.id::text as provider_id,
                       providers.provider_key,
                       providers.provider_template_id,
                       providers.display_name as provider_display_name,
                       providers.enabled as provider_enabled,
                       provider_models.model_id,
                       provider_models.display_name as model_display_name,
                       provider_models.input_modalities,
                       provider_models.output_modalities,
                       provider_models.context_window,
                       provider_models.max_output_tokens,
                       provider_models.supports_function_calling,
                       provider_models.supports_reasoning,
                       provider_models.supports_streaming,
                       provider_models.capability_metadata,
                       provider_models.availability,
                       provider_models.manual_input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
                       provider_models.manual_cached_input_usd_per_million_tokens::text as price_override_cached_input_usd_per_million_tokens,
                       provider_models.manual_output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
                       provider_models.manual_price_updated_at as price_override_updated_at,
                       provider_models.synced_input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
                       provider_models.synced_cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
                       provider_models.synced_output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
                       provider_models.synced_price_version as price_sync_price_version,
                       provider_models.synced_price_source_url as price_sync_source_url,
                       provider_models.synced_price_synced_at as price_sync_synced_at,
                       route_policy_candidates.candidate_order,
                       route_policy_candidates.tags,
                       route_policy_candidates.weight::text as weight
                from route_policy_candidates
                join provider_models on provider_models.id = route_policy_candidates.provider_model_id
                join providers on providers.id = provider_models.provider_id
                where route_policy_candidates.route_policy_id = any($1::uuid[])
                  and providers.deleted_at is null
                  and provider_models.deleted_at is null
                order by route_policy_candidates.candidate_order
              `,
              [policyIds],
            )
          ).rows;
    const candidatesByPolicyId = groupCandidatesByPolicyId(candidateRows);
    return policies.rows.map((policy) =>
      rowToConsoleRoutePolicy(policy, candidatesByPolicyId.get(policy.id) ?? []),
    );
  });
}

export async function createRoutePolicy(input: {
  databaseUrl?: string;
  routePolicy: NormalizedRoutePolicyFormInput;
}): Promise<ConsoleRoutePolicy> {
  const routePolicyId = randomUUID();
  let routePolicy: ConsoleRoutePolicy | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create route policy ${input.routePolicy.virtualModelId}`,
    changes: [{ table: "route_policies", recordId: routePolicyId }],
    write: async (client) => {
      routePolicy = await createRoutePolicyWithClient({
        client,
        routePolicy: input.routePolicy,
        routePolicyId,
      });
    },
  });

  return requireSavedRoutePolicy(routePolicy);
}

export async function createRoutePolicyWithClient(input: {
  client: QueryClient;
  routePolicy: NormalizedRoutePolicyFormInput;
  routePolicyId: string;
}): Promise<ConsoleRoutePolicy> {
  await lockProvidersForProviderModels(input.client, input.routePolicy.providerModelIds);
  await assertVirtualModelExists(input.client, input.routePolicy.virtualModelId);
  await assertVirtualModelHasNoRoutePolicy(input.client, input.routePolicy.virtualModelId);
  await assertProviderModelsExist(input.client, input.routePolicy.providerModelIds);
  await assertEndpointSupportedRoutePolicyCandidates(input.client, input.routePolicy);
  await assertRoutePolicyCandidateCapabilityContract(input.client, input.routePolicy);

  const result = await input.client.query<RoutePolicyRow>(
    `
      insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
      values ($1, $2, $3, $4)
      returning id::text,
                strategy,
                endpoint_protocol,
                virtual_model_id::text,
                (
                  select name
                  from virtual_models
                  where virtual_models.id = route_policies.virtual_model_id
                ) as virtual_model_name,
                (
                  select description
                  from virtual_models
                  where virtual_models.id = route_policies.virtual_model_id
                ) as virtual_model_display_name
    `,
    [
      input.routePolicyId,
      input.routePolicy.virtualModelId,
      input.routePolicy.strategy,
      input.routePolicy.endpointProtocol,
    ],
  );
  const candidateRows = await writeRoutePolicyCandidates(
    input.client,
    input.routePolicyId,
    input.routePolicy,
  );
  return rowToConsoleRoutePolicy(requireRow(result.rows[0]), candidateRows);
}

export async function updateRoutePolicy(input: {
  databaseUrl?: string;
  id: string;
  routePolicy: NormalizedRoutePolicyFormInput;
}): Promise<ConsoleRoutePolicy> {
  let routePolicy: ConsoleRoutePolicy | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update route policy ${input.id}`,
    changes: [{ table: "route_policies", recordId: input.id }],
    write: async (client) => {
      routePolicy = await updateRoutePolicyWithClient({
        client,
        id: input.id,
        routePolicy: input.routePolicy,
      });
    },
  });

  return requireSavedRoutePolicy(routePolicy);
}

/**
 * The write half on a caller's client, so a save that changes both the virtual
 * model and its route is one transaction. A route the capability contract
 * refuses must not leave a rename committed behind it.
 */
export async function updateRoutePolicyWithClient(input: {
  client: QueryClient;
  id: string;
  routePolicy: NormalizedRoutePolicyFormInput;
}): Promise<ConsoleRoutePolicy> {
  await lockProvidersForProviderModels(input.client, input.routePolicy.providerModelIds);
  const existing = await readRoutePolicyForUpdate(input.client, input.id);
  if (existing.virtual_model_id !== input.routePolicy.virtualModelId) {
    throw consoleConflictError(
      "Route policy virtual model cannot be changed.",
      "route_policy_virtual_model_immutable",
      { routePolicyId: input.id },
    );
  }
  await assertProviderModelsExist(input.client, input.routePolicy.providerModelIds);
  await assertEndpointSupportedRoutePolicyCandidates(input.client, input.routePolicy);
  await assertRoutePolicyCandidateCapabilityContract(input.client, input.routePolicy);

  const result = await input.client.query<RoutePolicyRow>(
    `
      update route_policies
      set strategy = $2,
          endpoint_protocol = $3,
          updated_at = now()
      where id = $1
      returning id::text,
                strategy,
                endpoint_protocol,
                virtual_model_id::text,
                (
                  select name
                  from virtual_models
                  where virtual_models.id = route_policies.virtual_model_id
                ) as virtual_model_name,
                (
                  select description
                  from virtual_models
                  where virtual_models.id = route_policies.virtual_model_id
                ) as virtual_model_display_name
    `,
    [input.id, input.routePolicy.strategy, input.routePolicy.endpointProtocol],
  );
  await input.client.query("delete from route_policy_candidates where route_policy_id = $1", [
    input.id,
  ]);
  const candidateRows = await writeRoutePolicyCandidates(input.client, input.id, input.routePolicy);
  return rowToConsoleRoutePolicy(requireRow(result.rows[0]), candidateRows);
}

export async function deleteRoutePolicy(input: {
  databaseUrl?: string;
  id: string;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete route policy ${input.id}`,
    changes: [{ table: "route_policies", recordId: input.id }],
    write: async (client) => {
      await readRoutePolicyForUpdate(client, input.id);
      const result = await client.query<{ id: string }>(
        `
          update route_policies
          set deleted_at = now(),
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text
        `,
        [input.id],
      );
      if (!result.rows[0]) {
        throw new Error("Route Policy was not deleted.");
      }
    },
  });
}

async function assertVirtualModelExists(
  client: QueryClient,
  virtualModelId: string,
): Promise<void> {
  const result = await client.query(
    "select 1 from virtual_models where id = $1 and deleted_at is null for update",
    [virtualModelId],
  );
  if (!result.rows[0]) {
    throw consoleNotFoundError("Virtual Model was not found.", "virtual_model_not_found", {
      virtualModelId,
    });
  }
}

async function assertVirtualModelHasNoRoutePolicy(
  client: QueryClient,
  virtualModelId: string,
): Promise<void> {
  const result = await client.query(
    "select 1 from route_policies where virtual_model_id = $1 and deleted_at is null limit 1",
    [virtualModelId],
  );
  if (result.rows[0]) {
    throw consoleConflictError(
      "Virtual Model already has a route policy.",
      "route_policy_virtual_model_conflict",
      { virtualModelId },
    );
  }
}

async function assertProviderModelsExist(
  client: QueryClient,
  providerModelIds: readonly string[],
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `
      select provider_models.id::text
      from provider_models
      join providers on providers.id = provider_models.provider_id
      where provider_models.id = any($1::uuid[])
        and provider_models.deleted_at is null
        and providers.deleted_at is null
    `,
    [providerModelIds],
  );
  const foundIds = new Set(result.rows.map((row) => row.id));
  const missingIds = providerModelIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw consoleValidationError(
      "Route policy candidate provider model was not found.",
      "route_policy_provider_model_not_found",
      { providerModelIds: missingIds },
    );
  }
}

async function assertEndpointSupportedRoutePolicyCandidates(
  client: QueryClient,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<void> {
  const candidates = await readProviderModelOptionsById(client, routePolicy.providerModelIds);
  const unsupportedCandidates = candidates.filter(
    (candidate) =>
      isEmbeddingOnlyProviderModel(candidate) ||
      !candidate.supportedEndpoints.includes(routePolicy.endpointProtocol),
  );
  if (unsupportedCandidates.length === 0) {
    return;
  }

  throw consoleValidationError(
    `Route policy endpoint ${routePolicy.endpointProtocol} is not supported by ${unsupportedCandidates
      .map((candidate) => candidate.optionLabel)
      .join(", ")}.`,
    "route_policy_endpoint_unsupported",
    { endpointProtocol: routePolicy.endpointProtocol },
  );
}

/**
 * Only the strategies whose candidates all answer the same request have to agree
 * on capabilities. A strategy that routes one named candidate per request is
 * checked against the candidate it picked, at request time.
 */
async function assertRoutePolicyCandidateCapabilityContract(
  client: QueryClient,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<void> {
  if (routeStrategyCapabilityContractScope(routePolicy.strategy) !== "all_candidates") {
    return;
  }

  const candidates = await readProviderModelOptionsById(client, routePolicy.providerModelIds);
  const result = resolveVirtualModelCapabilityContract(
    candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.optionLabel,
      inputModalities: candidate.inputModalities,
      maxContextTokens: candidate.contextWindow,
      maxOutputTokens: candidate.maxOutputTokens,
      outputModalities: candidate.outputModalities,
      supportsFunctionCalling: candidate.supportsFunctionCalling,
      supportsReasoning: candidate.supportsReasoning,
    })),
  );

  if (result.ok) {
    return;
  }

  throw consoleValidationError(result.message, result.code, result.details);
}

async function readProviderModelOptionsById(
  client: QueryClient,
  providerModelIds: readonly string[],
): Promise<ConsoleProviderModelOption[]> {
  if (providerModelIds.length === 0) {
    return [];
  }

  const result = await client.query<ProviderModelOptionRow>(
    `
      ${providerModelOptionsSelectSql()}
      where provider_models.id = any($1::uuid[])
        and provider_models.deleted_at is null
        and providers.deleted_at is null
      order by providers.display_name, provider_models.display_name
    `,
    [providerModelIds],
  );
  return result.rows.map(rowToProviderModelOption);
}

async function readRoutePolicyForUpdate(
  client: QueryClient,
  routePolicyId: string,
): Promise<RoutePolicyRow> {
  const result = await client.query<RoutePolicyRow>(
    `
      select route_policies.id::text,
             route_policies.strategy,
             route_policies.endpoint_protocol,
             route_policies.virtual_model_id::text,
             virtual_models.name as virtual_model_name,
             virtual_models.description as virtual_model_display_name
      from route_policies
      join virtual_models on virtual_models.id = route_policies.virtual_model_id
      where route_policies.id = $1
        and route_policies.deleted_at is null
        and virtual_models.deleted_at is null
      for update of route_policies
    `,
    [routePolicyId],
  );
  return requireRow(result.rows[0]);
}

async function writeRoutePolicyCandidates(
  client: QueryClient,
  routePolicyId: string,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<ConsoleRoutePolicyCandidate[]> {
  const candidateRows: ConsoleRoutePolicyCandidate[] = [];

  for (const [index, providerModelId] of routePolicy.providerModelIds.entries()) {
    const result = await client.query<CandidateRow>(
      `
        with inserted as (
          insert into route_policy_candidates (
            id,
            route_policy_id,
            provider_model_id,
            candidate_order,
            tags,
            weight
          )
          values ($1, $2, $3, $4, $5::text[], $6)
          returning route_policy_id,
                    provider_model_id,
                    candidate_order,
                    tags,
                    weight
        )
        select inserted.route_policy_id::text,
               provider_models.id::text as id,
               providers.id::text as provider_id,
               providers.provider_key,
               providers.provider_template_id,
               providers.display_name as provider_display_name,
               providers.enabled as provider_enabled,
               provider_models.model_id,
               provider_models.display_name as model_display_name,
               provider_models.context_window,
               provider_models.supports_streaming,
               provider_models.input_modalities,
               provider_models.output_modalities,
               provider_models.max_output_tokens,
               provider_models.supports_function_calling,
               provider_models.supports_reasoning,
               provider_models.capability_metadata,
               provider_models.availability,
               provider_models.manual_input_usd_per_million_tokens::text
                 as price_override_input_usd_per_million_tokens,
               provider_models.manual_cached_input_usd_per_million_tokens::text
                 as price_override_cached_input_usd_per_million_tokens,
               provider_models.manual_output_usd_per_million_tokens::text
                 as price_override_output_usd_per_million_tokens,
               provider_models.manual_price_updated_at as price_override_updated_at,
               provider_models.synced_input_usd_per_million_tokens::text
                 as price_sync_input_usd_per_million_tokens,
               provider_models.synced_cached_input_usd_per_million_tokens::text
                 as price_sync_cached_input_usd_per_million_tokens,
               provider_models.synced_output_usd_per_million_tokens::text
                 as price_sync_output_usd_per_million_tokens,
               provider_models.synced_price_version as price_sync_price_version,
               provider_models.synced_price_source_url as price_sync_source_url,
               provider_models.synced_price_synced_at as price_sync_synced_at,
               inserted.candidate_order,
               inserted.tags,
               inserted.weight::text as weight
        from inserted
        join provider_models on provider_models.id = inserted.provider_model_id
        join providers on providers.id = provider_models.provider_id
        where provider_models.deleted_at is null
          and providers.deleted_at is null
      `,
      [
        randomUUID(),
        routePolicyId,
        providerModelId,
        index + 1,
        routePolicy.candidateTags[index] ?? [],
        routePolicy.candidateWeights[index] ?? null,
      ],
    );
    candidateRows.push(rowToConsoleRoutePolicyCandidate(requireRow(result.rows[0])));
  }

  return candidateRows;
}

function normalizeUuidList(input?: readonly (string | null | undefined)[]): string[] {
  return (input ?? [])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      if (!isUuid(value)) {
        throw consoleValidationError(
          "Route policy candidate provider model id is invalid.",
          "route_policy_provider_model_id_invalid",
        );
      }
      return value;
    });
}

function isRoutePolicyStrategy(value: string | null | undefined): value is RoutePolicyStrategy {
  return routePolicyStrategies.includes(value as RoutePolicyStrategy);
}

function normalizeRequiredEndpointProtocol(
  value: string | null | undefined,
): RouteEndpointProtocol {
  const protocol = normalizeOptionalEndpointProtocol(value);
  if (!protocol) {
    throw consoleValidationError(
      "Route policy endpoint protocol is required.",
      "route_policy_endpoint_required",
      { field: "endpointProtocol" },
    );
  }
  return protocol;
}

function normalizeOptionalEndpointProtocol(
  value: string | null | undefined,
): RouteEndpointProtocol | null {
  const protocol = value?.trim();
  if (!protocol) {
    return null;
  }
  if (!isRouteEndpointProtocol(protocol)) {
    throw consoleValidationError(
      "Route policy endpoint protocol must be chat_completions, responses, or messages.",
      "route_policy_endpoint_invalid",
      { field: "endpointProtocol" },
    );
  }
  return protocol;
}

function isRouteEndpointProtocol(value: string): value is RouteEndpointProtocol {
  return routeEndpointProtocols.includes(value as RouteEndpointProtocol);
}

function normalizeOptionalFilter(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function providerModelOptionsSql(): string {
  return `
    ${providerModelOptionsSelectSql()}
    where provider_models.deleted_at is null
      and provider_models.availability = 'available'
      and providers.deleted_at is null
      and ${consoleVisibleProviderModelFilterSql}
    order by providers.display_name, provider_models.display_name
  `;
}

function providerModelOptionsSelectSql(): string {
  return `
    select provider_models.id::text,
           providers.id::text as provider_id,
           providers.provider_key,
           providers.provider_template_id,
           providers.display_name as provider_display_name,
           providers.enabled as provider_enabled,
           provider_models.model_id,
           provider_models.display_name as model_display_name,
           provider_models.context_window,
           provider_models.supports_streaming,
           provider_models.input_modalities,
           provider_models.output_modalities,
           provider_models.max_output_tokens,
           provider_models.supports_function_calling,
           provider_models.supports_reasoning,
           provider_models.capability_metadata,
           provider_models.availability,
           provider_models.manual_input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
           provider_models.manual_cached_input_usd_per_million_tokens::text as price_override_cached_input_usd_per_million_tokens,
           provider_models.manual_output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
           provider_models.manual_price_updated_at as price_override_updated_at,
           provider_models.synced_input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
           provider_models.synced_cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
           provider_models.synced_output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
           provider_models.synced_price_version as price_sync_price_version,
           provider_models.synced_price_source_url as price_sync_source_url,
           provider_models.synced_price_synced_at as price_sync_synced_at
    from provider_models
    join providers on providers.id = provider_models.provider_id
  `;
}

function groupCandidatesByPolicyId(
  rows: CandidateRow[],
): Map<string, ConsoleRoutePolicyCandidate[]> {
  const candidatesByPolicyId = new Map<string, ConsoleRoutePolicyCandidate[]>();
  for (const row of rows) {
    const candidates = candidatesByPolicyId.get(row.route_policy_id) ?? [];
    candidates.push(rowToConsoleRoutePolicyCandidate(row));
    candidatesByPolicyId.set(row.route_policy_id, candidates);
  }
  return candidatesByPolicyId;
}

function rowToConsoleRoutePolicy(
  row: RoutePolicyRow,
  candidates: ConsoleRoutePolicyCandidate[],
): ConsoleRoutePolicy {
  return {
    candidates,
    endpointProtocol: row.endpoint_protocol,
    id: row.id,
    routeReason: buildRouteReasonMetadata({
      candidateCount: candidates.length,
      strategy: row.strategy,
      virtualModelName: row.virtual_model_name,
    }),
    routeWarnings: [
      ...buildRoutePolicyWarnings(candidates),
      ...buildTagRouteCoverageWarnings(candidates),
    ],
    strategy: row.strategy,
    virtualModelDisplayName: row.virtual_model_display_name,
    virtualModelId: row.virtual_model_id,
    virtualModelName: row.virtual_model_name,
  };
}

function rowToConsoleRoutePolicyCandidate(row: CandidateRow): ConsoleRoutePolicyCandidate {
  return {
    ...rowToProviderModelOption(row),
    candidateOrder: row.candidate_order,
    tags: row.tags ?? [],
    weight: row.weight === null || row.weight === undefined ? null : Number(row.weight),
  };
}

function rowToProviderModelOption(row: ProviderModelOptionRow): ConsoleProviderModelOption {
  const price = resolveEffectiveModelTokenPrice({
    manualOverride: buildManualPriceOverride({
      cachedInputUsdPerMillionTokens: row.price_override_cached_input_usd_per_million_tokens,
      inputUsdPerMillionTokens: row.price_override_input_usd_per_million_tokens,
      modelId: row.model_id,
      outputUsdPerMillionTokens: row.price_override_output_usd_per_million_tokens,
      providerKey: row.provider_key,
      updatedAt: row.price_override_updated_at,
    }),
    modelId: row.model_id,
    providerKey: row.provider_key,
    syncedPrice: buildSyncedPriceSnapshot({
      cachedInputUsdPerMillionTokens: row.price_sync_cached_input_usd_per_million_tokens,
      inputUsdPerMillionTokens: row.price_sync_input_usd_per_million_tokens,
      modelId: row.model_id,
      outputUsdPerMillionTokens: row.price_sync_output_usd_per_million_tokens,
      priceVersion: row.price_sync_price_version,
      providerKey: row.provider_key,
      sourceUrl: row.price_sync_source_url,
      syncedAt: row.price_sync_synced_at,
    }),
  });
  const priceStatusLabel = formatProviderModelPriceStatusLabel(price);

  return {
    availability: row.availability,
    capabilityMetadata: readProviderModelCapabilityMetadata(row.capability_metadata),
    contextWindow: row.context_window ?? null,
    id: row.id,
    inputModalities: row.input_modalities ?? null,
    maxOutputTokens: row.max_output_tokens ?? null,
    modelDisplayName: row.model_display_name,
    modelId: row.model_id,
    optionLabel: formatProviderModelOptionLabel({
      modelDisplayName: row.model_display_name,
      modelId: row.model_id,
      providerDisplayName: row.provider_display_name,
    }),
    pricedOptionLabel: formatPricedProviderModelOptionLabel({
      modelDisplayName: row.model_display_name,
      modelId: row.model_id,
      priceStatusLabel,
      providerDisplayName: row.provider_display_name,
    }),
    priceStatus: price.status,
    priceStatusLabel,
    inputUsdPerMillionTokens:
      price.status === "unknown_price" ? null : price.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens:
      price.status === "unknown_price" ? null : price.outputUsdPerMillionTokens,
    providerDisplayName: row.provider_display_name,
    providerEnabled: row.provider_enabled,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    outputModalities: row.output_modalities ?? null,
    supportedEndpoints: listProviderRouteEndpointProtocols(row.provider_key),
    supportsFunctionCalling: row.supports_function_calling ?? null,
    supportsReasoning: row.supports_reasoning ?? null,
    supportsStreaming: row.supports_streaming ?? false,
  };
}

function isEmbeddingOnlyProviderModel(candidate: ConsoleProviderModelOption): boolean {
  return (
    candidate.outputModalities?.includes("embedding") === true &&
    !candidate.outputModalities.includes("text")
  );
}

function readProviderModelCapabilityMetadata(value: unknown): ProviderModelCapabilityMetadata {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderModelCapabilityMetadata)
    : {};
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw consoleNotFoundError("Route Policy was not found.", "route_policy_not_found");
  }
  return row;
}

function requireSavedRoutePolicy(routePolicy: ConsoleRoutePolicy | undefined): ConsoleRoutePolicy {
  if (!routePolicy) {
    throw new Error("Route Policy was not saved.");
  }
  return routePolicy;
}

/**
 * Resolve specific provider models by id. The route editor keeps its selection
 * in the URL so paging the candidate browser cannot lose it, which means the
 * selected rows have to be readable independently of the current page.
 */
export async function listProviderModelOptionsByIds(input: {
  databaseUrl?: string;
  providerModelIds: readonly string[];
}): Promise<ConsoleProviderModelOption[]> {
  if (input.providerModelIds.length === 0) {
    return [];
  }
  return withPooledPostgresClient(input.databaseUrl, async (client) =>
    readProviderModelOptionsById(client, input.providerModelIds),
  );
}
