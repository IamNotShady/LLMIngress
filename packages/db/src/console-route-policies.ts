import { randomUUID } from "node:crypto";
import {
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import { PostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import {
  type ModelInputModality,
  type ModelOutputModality,
  type ProviderModelCapabilityMetadata,
  type RouteEndpointProtocol,
  resolveVirtualModelCapabilityContract,
  routeEndpointProtocols,
} from "@llmingress/domain";
import {
  consoleConflictError,
  consoleNotFoundError,
  consoleValidationError,
} from "./console-operation-error.ts";
import { listProviderTemplateEndpointProtocols } from "./console-provider-templates.ts";
import { lockProvidersForProviderModels } from "./console-providers.ts";
import { buildManualPriceOverride, buildSyncedPriceSnapshot } from "./price-rows.ts";

export const routePolicyStrategies = ["fixed", "cost_first", "random"] as const;

export type RoutePolicyStrategy = (typeof routePolicyStrategies)[number];

export type RoutePolicyFormInput = {
  endpointProtocol?: string | null;
  providerModelIds?: readonly (string | null | undefined)[];
  strategy?: string | null;
  virtualModelId?: string | null;
};

export type NormalizedRoutePolicyFormInput = {
  endpointProtocol: RouteEndpointProtocol;
  providerModelIds: string[];
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
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

export type RoutePolicyEditorProviderHealth = {
  id: string;
  status: string | null | undefined;
};

export type RoutePolicyHealthWarningCandidate = {
  modelHealthStatus?: string | null;
  optionLabel: string;
  providerHealthStatus?: string | null;
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

type BudgetedVirtualModelUsageRow = {
  budgeted_agent_count: number;
  display_name: string;
  name: string;
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
      "Route policy strategy must be fixed, cost_first, or random.",
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
    endpointProtocol,
    providerModelIds,
    strategy,
    virtualModelId,
  };
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
        `Price warning: ${candidate.optionLabel} has unknown price; save a manual price override before using budgeted routes.`,
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

export function buildRoutePolicyHealthWarnings(
  candidates: readonly RoutePolicyHealthWarningCandidate[],
): string[] {
  const warnings: string[] = [];

  for (const candidate of candidates) {
    if (isWarningHealthStatus(candidate.providerHealthStatus)) {
      warnings.push(
        `Health warning: ${candidate.optionLabel} provider health is ${formatRoutePolicyHealthStatus(
          candidate.providerHealthStatus,
        )}.`,
      );
    }
    if (isWarningHealthStatus(candidate.modelHealthStatus)) {
      warnings.push(
        `Health warning: ${candidate.optionLabel} model health is ${formatRoutePolicyHealthStatus(
          candidate.modelHealthStatus,
        )}.`,
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

export function filterRoutePolicyEditorHealthyProviderModelOptions(
  options: readonly ConsoleProviderModelOption[],
  providerHealth: readonly RoutePolicyEditorProviderHealth[],
): ConsoleProviderModelOption[] {
  const unhealthyProviderIds = new Set(
    providerHealth
      .filter((summary) => isWarningHealthStatus(summary.status))
      .map((summary) => summary.id),
  );
  return options.filter((option) => !unhealthyProviderIds.has(option.providerId));
}

export function listProviderRouteEndpointProtocols(input: {
  providerKey: string;
  providerTemplateId?: string | null;
}): RouteEndpointProtocol[] {
  if (input.providerTemplateId) {
    return listProviderTemplateEndpointProtocols(input.providerTemplateId).filter(
      isRouteEndpointProtocol,
    );
  }

  if (input.providerKey === "openai") {
    return ["chat_completions", "responses", "embeddings"];
  }
  if (input.providerKey === "anthropic") {
    return ["messages"];
  }
  return [];
}

export function mergeRoutePolicyEditorProviderModelOptions(
  filteredOptions: readonly ConsoleProviderModelOption[],
  selectedCandidates: readonly ConsoleProviderModelOption[],
): ConsoleProviderModelOption[] {
  const merged = [...filteredOptions];
  const existingIds = new Set(merged.map((option) => option.id));

  for (const candidate of selectedCandidates) {
    if (!existingIds.has(candidate.id)) {
      merged.push(candidate);
      existingIds.add(candidate.id);
    }
  }

  return merged;
}

export function formatProviderModelPriceStatusLabel(price: ModelTokenPrice): string {
  if (price.status === "unknown_price") {
    return "Unknown price";
  }

  if (price.source === "manual_override") {
    return "Priced (manual override)";
  }
  if (price.source === "price_sync") {
    return "Priced (price sync)";
  }
  return "Priced (built-in)";
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
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderModelOptionRow>(providerModelOptionsSql());
    return result.rows.map(rowToProviderModelOption);
  });
}

export async function listRoutePolicies(databaseUrl?: string): Promise<ConsoleRoutePolicy[]> {
  return withClient(databaseUrl, async (client) => {
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
                       route_policy_candidates.candidate_order
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
      await lockProvidersForProviderModels(client, input.routePolicy.providerModelIds);
      await assertVirtualModelExists(client, input.routePolicy.virtualModelId);
      await assertVirtualModelHasNoRoutePolicy(client, input.routePolicy.virtualModelId);
      await assertProviderModelsExist(client, input.routePolicy.providerModelIds);
      await assertEndpointSupportedRoutePolicyCandidates(client, input.routePolicy);
      await assertRoutePolicyCandidateCapabilityContract(client, input.routePolicy);
      await assertBudgetSafeRoutePolicyCandidates(client, input.routePolicy);

      const result = await client.query<RoutePolicyRow>(
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
          routePolicyId,
          input.routePolicy.virtualModelId,
          input.routePolicy.strategy,
          input.routePolicy.endpointProtocol,
        ],
      );
      const candidateRows = await writeRoutePolicyCandidates(
        client,
        routePolicyId,
        input.routePolicy,
      );
      routePolicy = rowToConsoleRoutePolicy(requireRow(result.rows[0]), candidateRows);
    },
  });

  return requireSavedRoutePolicy(routePolicy);
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
      await lockProvidersForProviderModels(client, input.routePolicy.providerModelIds);
      const existing = await readRoutePolicyForUpdate(client, input.id);
      if (existing.virtual_model_id !== input.routePolicy.virtualModelId) {
        throw consoleConflictError(
          "Route policy virtual model cannot be changed.",
          "route_policy_virtual_model_immutable",
          { routePolicyId: input.id },
        );
      }
      await assertProviderModelsExist(client, input.routePolicy.providerModelIds);
      await assertEndpointSupportedRoutePolicyCandidates(client, input.routePolicy);
      await assertRoutePolicyCandidateCapabilityContract(client, input.routePolicy);
      await assertBudgetSafeRoutePolicyCandidates(client, input.routePolicy);

      const result = await client.query<RoutePolicyRow>(
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
      await client.query("delete from route_policy_candidates where route_policy_id = $1", [
        input.id,
      ]);
      const candidateRows = await writeRoutePolicyCandidates(client, input.id, input.routePolicy);
      routePolicy = rowToConsoleRoutePolicy(requireRow(result.rows[0]), candidateRows);
    },
  });

  return requireSavedRoutePolicy(routePolicy);
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

async function assertBudgetSafeRoutePolicyCandidates(
  client: QueryClient,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<void> {
  const budgetedUsage = await readBudgetedVirtualModelUsage(client, routePolicy.virtualModelId);
  if (budgetedUsage.budgeted_agent_count === 0) {
    return;
  }

  const candidates = await readProviderModelOptionsById(client, routePolicy.providerModelIds);
  const unknownPriceCandidates = candidates.filter(
    (candidate) => candidate.priceStatus === "unknown_price",
  );
  if (unknownPriceCandidates.length === 0) {
    return;
  }

  const candidateLabels = unknownPriceCandidates
    .map((candidate) => `${candidate.modelDisplayName} (${candidate.modelId})`)
    .join(", ");
  const modelLabel = `${budgetedUsage.display_name} (${budgetedUsage.name})`;
  throw consoleValidationError(
    `Cannot save Route Policy for ${modelLabel} because ${candidateLabels} has unknown price. Save a manual price override or choose a priced replacement.`,
    "route_policy_candidate_unknown_price",
  );
}

async function assertEndpointSupportedRoutePolicyCandidates(
  client: QueryClient,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<void> {
  const candidates = await readProviderModelOptionsById(client, routePolicy.providerModelIds);
  const unsupportedCandidates = candidates.filter(
    (candidate) => !candidate.supportedEndpoints.includes(routePolicy.endpointProtocol),
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

async function assertRoutePolicyCandidateCapabilityContract(
  client: QueryClient,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<void> {
  const candidates = await readProviderModelOptionsById(client, routePolicy.providerModelIds);
  const result = resolveVirtualModelCapabilityContract(
    candidates.map((candidate) => ({
      id: candidate.id,
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

async function readBudgetedVirtualModelUsage(
  client: QueryClient,
  virtualModelId: string,
): Promise<BudgetedVirtualModelUsageRow> {
  const result = await client.query<BudgetedVirtualModelUsageRow>(
    `
      select virtual_models.name,
             virtual_models.description as display_name,
             count(distinct agents.id) filter (where agent_limits.id is not null)::integer as budgeted_agent_count
      from virtual_models
      left join agents
        on agents.enabled = true
       and agents.deleted_at is null
       and (
            agents.default_virtual_model_id = virtual_models.id
            or exists (
              select 1
              from agent_virtual_models
              where agent_virtual_models.agent_id = agents.id
                and agent_virtual_models.virtual_model_id = virtual_models.id
            )
       )
      left join agent_limits
        on agent_limits.agent_id = agents.id
       and agent_limits.enabled = true
       and agent_limits.limit_type = 'budget'
       and agent_limits.unit = 'usd'
      where virtual_models.id = $1
        and virtual_models.deleted_at is null
      group by virtual_models.id, virtual_models.name, virtual_models.description
    `,
    [virtualModelId],
  );
  return requireRow(result.rows[0]);
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
            candidate_order
          )
          values ($1, $2, $3, $4)
          returning route_policy_id,
                    provider_model_id,
                    candidate_order
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
               inserted.candidate_order
        from inserted
        join provider_models on provider_models.id = inserted.provider_model_id
        join providers on providers.id = provider_models.provider_id
        where provider_models.deleted_at is null
          and providers.deleted_at is null
      `,
      [randomUUID(), routePolicyId, providerModelId, index + 1],
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
      "Route policy endpoint protocol must be chat_completions, responses, messages, or embeddings.",
      "route_policy_endpoint_invalid",
      { field: "endpointProtocol" },
    );
  }
  return protocol;
}

function isRouteEndpointProtocol(value: string): value is RouteEndpointProtocol {
  return routeEndpointProtocols.includes(value as RouteEndpointProtocol);
}

function isWarningHealthStatus(value: string | null | undefined): value is string {
  return (
    value === "auth_failed" ||
    value === "network_error" ||
    value === "quota_limited" ||
    value === "unhealthy"
  );
}

function formatRoutePolicyHealthStatus(value: string): string {
  return (
    {
      auth_failed: "Auth failed",
      network_error: "Network error",
      quota_limited: "Quota limited",
      unhealthy: "Unhealthy",
    }[value] ?? `${value.charAt(0).toUpperCase()}${value.slice(1)}`
  );
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
    routeWarnings: buildRoutePolicyWarnings(candidates),
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
    supportedEndpoints: listProviderRouteEndpointProtocols({
      providerKey: row.provider_key,
      providerTemplateId: row.provider_template_id,
    }),
    supportsFunctionCalling: row.supports_function_calling ?? null,
    supportsReasoning: row.supports_reasoning ?? null,
    supportsStreaming: row.supports_streaming ?? false,
  };
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

async function withClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
