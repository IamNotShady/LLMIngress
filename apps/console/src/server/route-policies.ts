import { randomUUID } from "node:crypto";
import {
  type ManualPriceOverride,
  type ModelTokenPrice,
  resolveEffectiveModelTokenPrice,
  type SyncedPriceSnapshot,
} from "@llmingress/billing/price-registry";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export const routePolicyStrategies = ["fixed", "cost_first", "balanced", "quality_first"] as const;

export type RoutePolicyStrategy = (typeof routePolicyStrategies)[number];

export type RoutePolicyFormInput = {
  fallbackProviderModelIds?: readonly (string | null | undefined)[];
  primaryProviderModelIds?: readonly (string | null | undefined)[];
  strategy?: string | null;
  virtualModelId?: string | null;
};

export type NormalizedRoutePolicyFormInput = {
  fallbackProviderModelIds: string[];
  primaryProviderModelIds: string[];
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
};

export type ConsoleProviderModelOption = {
  availability: string;
  id: string;
  modelDisplayName: string;
  modelId: string;
  optionLabel: string;
  pricedOptionLabel: string;
  priceStatus: ModelTokenPrice["status"];
  priceStatusLabel: string;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
  providerEnabled: boolean;
};

export type ConsoleRoutePolicyCandidate = ConsoleProviderModelOption & {
  candidateOrder: number;
  isFallback: boolean;
};

export type ConsoleRoutePolicy = {
  candidates: ConsoleRoutePolicyCandidate[];
  fallbackCandidates: ConsoleRoutePolicyCandidate[];
  id: string;
  primaryCandidates: ConsoleRoutePolicyCandidate[];
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
  modelQuery?: string | null;
  providerKey?: string | null;
};

export type RoutePolicyEditorFilters = {
  modelQuery: string | null;
  providerKey: string | null;
};

export type RoutePolicyHealthWarningCandidate = {
  modelHealthIsStale?: boolean;
  modelHealthStatus?: string | null;
  optionLabel: string;
  providerHealthIsStale?: boolean;
  providerHealthStatus?: string | null;
};

export type RouteReasonMetadataInput = {
  fallbackCandidateCount: number;
  primaryCandidateCount: number;
  strategy: RoutePolicyStrategy;
  virtualModelName: string;
};

type RoutePolicyRow = QueryResultRow & {
  id: string;
  strategy: RoutePolicyStrategy;
  virtual_model_display_name: string;
  virtual_model_id: string;
  virtual_model_name: string;
};

type CandidateRow = QueryResultRow & {
  availability: string;
  candidate_order: number;
  id: string;
  is_fallback: boolean;
  model_display_name: string;
  model_id: string;
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
  route_policy_id: string;
};

type ProviderModelOptionRow = QueryResultRow & {
  availability: string;
  id: string;
  model_display_name: string;
  model_id: string;
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
};

type BudgetedVirtualModelUsageRow = QueryResultRow & {
  budgeted_agent_api_key_count: number;
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
  const virtualModelId = input.virtualModelId?.trim();
  const strategy = input.strategy?.trim();
  const primaryProviderModelIds = normalizeUuidList(input.primaryProviderModelIds);
  const fallbackProviderModelIds = normalizeUuidList(input.fallbackProviderModelIds);

  if (!virtualModelId || !isUuid(virtualModelId)) {
    throw new Error("Route policy virtual model is required.");
  }
  if (!isRoutePolicyStrategy(strategy)) {
    throw new Error("Route policy strategy must be fixed, cost_first, balanced, or quality_first.");
  }
  if (primaryProviderModelIds.length === 0) {
    throw new Error("Route policy requires at least one primary provider model.");
  }

  const candidateIds = [...primaryProviderModelIds, ...fallbackProviderModelIds];
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("Route policy candidates must not contain duplicate provider models.");
  }

  return {
    fallbackProviderModelIds,
    primaryProviderModelIds,
    strategy,
    virtualModelId,
  };
}

export function buildRouteReasonMetadata(input: RouteReasonMetadataInput): string {
  const primary = `${input.primaryCandidateCount} primary ${pluralize(
    "candidate",
    input.primaryCandidateCount,
  )}`;
  const fallback =
    input.fallbackCandidateCount === 0
      ? "no fallback"
      : `${input.fallbackCandidateCount} ${pluralize("fallback", input.fallbackCandidateCount)}`;
  return `${input.strategy} route for ${input.virtualModelName} uses ${primary} with ${fallback}.`;
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
    if (candidate.providerHealthIsStale) {
      warnings.push(`Health warning: ${candidate.optionLabel} provider health is stale.`);
    }
    if (candidate.modelHealthIsStale) {
      warnings.push(`Health warning: ${candidate.optionLabel} model health is stale.`);
    }
  }

  return warnings;
}

export function normalizeRoutePolicyEditorFilters(
  input: RoutePolicyEditorFilterInput,
): RoutePolicyEditorFilters {
  return {
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
  databaseUrl: string,
): Promise<ConsoleProviderModelOption[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderModelOptionRow>(providerModelOptionsSql());
    return result.rows.map(rowToProviderModelOption);
  });
}

export async function listRoutePolicies(databaseUrl: string): Promise<ConsoleRoutePolicy[]> {
  return withClient(databaseUrl, async (client) => {
    const policies = await client.query<RoutePolicyRow>(
      `
        select route_policies.id::text,
               route_policies.strategy,
               virtual_models.id::text as virtual_model_id,
               virtual_models.name as virtual_model_name,
               virtual_models.display_name as virtual_model_display_name
        from route_policies
        join virtual_models on virtual_models.id = route_policies.virtual_model_id
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
                       providers.display_name as provider_display_name,
                       providers.enabled as provider_enabled,
                       provider_models.model_id,
                       provider_models.display_name as model_display_name,
                       provider_models.availability,
                       provider_models.manual_input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
                       provider_models.manual_cached_input_usd_per_million_tokens::text as price_override_cached_input_usd_per_million_tokens,
                       provider_models.manual_output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
                       provider_models.manual_price_updated_at as price_override_updated_at,
                       latest_provider_model_price.input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
                       latest_provider_model_price.cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
                       latest_provider_model_price.output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
                       latest_provider_model_price.price_version as price_sync_price_version,
                       latest_provider_model_price.source_url as price_sync_source_url,
                       latest_provider_model_price.synced_at as price_sync_synced_at,
                       route_policy_candidates.candidate_order,
                       route_policy_candidates.is_fallback
                from route_policy_candidates
                join provider_models on provider_models.id = route_policy_candidates.provider_model_id
                join providers on providers.id = provider_models.provider_id
                left join lateral (
                  select input_usd_per_million_tokens,
                         cached_input_usd_per_million_tokens,
                         output_usd_per_million_tokens,
                         price_version,
                         source_url,
                         synced_at
                  from provider_models_price
                  where lower(provider_models_price.provider_key) = lower(providers.provider_key)
                    and provider_models_price.model_id = provider_models.model_id
                  order by case provider_models_price.source
                             when 'models.dev' then 0
                             when 'litellm' then 1
                             else 2
                           end,
                           synced_at desc,
                           updated_at desc
                  limit 1
                ) latest_provider_model_price on true
                where route_policy_candidates.route_policy_id = any($1::uuid[])
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
  databaseUrl: string;
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
      await assertVirtualModelExists(client, input.routePolicy.virtualModelId);
      await assertVirtualModelHasNoRoutePolicy(client, input.routePolicy.virtualModelId);
      await assertProviderModelsExist(client, [
        ...input.routePolicy.primaryProviderModelIds,
        ...input.routePolicy.fallbackProviderModelIds,
      ]);
      await assertBudgetSafeRoutePolicyCandidates(client, input.routePolicy);

      const result = await client.query<RoutePolicyRow>(
        `
          insert into route_policies (id, virtual_model_id, strategy)
          values ($1, $2, $3)
          returning id::text,
                    strategy,
                    virtual_model_id::text,
                    (
                      select name
                      from virtual_models
                      where virtual_models.id = route_policies.virtual_model_id
                    ) as virtual_model_name,
                    (
                      select display_name
                      from virtual_models
                      where virtual_models.id = route_policies.virtual_model_id
                    ) as virtual_model_display_name
        `,
        [routePolicyId, input.routePolicy.virtualModelId, input.routePolicy.strategy],
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
  databaseUrl: string;
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
      const existing = await readRoutePolicyForUpdate(client, input.id);
      if (existing.virtual_model_id !== input.routePolicy.virtualModelId) {
        throw new Error("Route policy virtual model cannot be changed.");
      }
      await assertProviderModelsExist(client, [
        ...input.routePolicy.primaryProviderModelIds,
        ...input.routePolicy.fallbackProviderModelIds,
      ]);
      await assertBudgetSafeRoutePolicyCandidates(client, input.routePolicy);

      const result = await client.query<RoutePolicyRow>(
        `
          update route_policies
          set strategy = $2,
              updated_at = now()
          where id = $1
          returning id::text,
                    strategy,
                    virtual_model_id::text,
                    (
                      select name
                      from virtual_models
                      where virtual_models.id = route_policies.virtual_model_id
                    ) as virtual_model_name,
                    (
                      select display_name
                      from virtual_models
                      where virtual_models.id = route_policies.virtual_model_id
                    ) as virtual_model_display_name
        `,
        [input.id, input.routePolicy.strategy],
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

export async function deleteRoutePolicy(input: { databaseUrl: string; id: string }): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete route policy ${input.id}`,
    changes: [{ table: "route_policies", recordId: input.id }],
    write: async (client) => {
      await readRoutePolicyForUpdate(client, input.id);
      const result = await client.query<{ id: string }>(
        "delete from route_policies where id = $1 returning id::text",
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
  const result = await client.query("select 1 from virtual_models where id = $1 for update", [
    virtualModelId,
  ]);
  if (!result.rows[0]) {
    throw new Error("Virtual Model was not found.");
  }
}

async function assertVirtualModelHasNoRoutePolicy(
  client: QueryClient,
  virtualModelId: string,
): Promise<void> {
  const result = await client.query(
    "select 1 from route_policies where virtual_model_id = $1 limit 1",
    [virtualModelId],
  );
  if (result.rows[0]) {
    throw new Error("Virtual Model already has a route policy.");
  }
}

async function assertProviderModelsExist(
  client: QueryClient,
  providerModelIds: readonly string[],
): Promise<void> {
  const result = await client.query<{ id: string }>(
    "select id::text from provider_models where id = any($1::uuid[])",
    [providerModelIds],
  );
  const foundIds = new Set(result.rows.map((row) => row.id));
  const missingIds = providerModelIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw new Error("Route policy candidate provider model was not found.");
  }
}

async function assertBudgetSafeRoutePolicyCandidates(
  client: QueryClient,
  routePolicy: NormalizedRoutePolicyFormInput,
): Promise<void> {
  const budgetedUsage = await readBudgetedVirtualModelUsage(client, routePolicy.virtualModelId);
  if (budgetedUsage.budgeted_agent_api_key_count === 0) {
    return;
  }

  const candidates = await readProviderModelOptionsById(client, [
    ...routePolicy.primaryProviderModelIds,
    ...routePolicy.fallbackProviderModelIds,
  ]);
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
  throw new Error(
    `Cannot save Route Policy for ${modelLabel} because ${candidateLabels} has unknown price. Save a manual price override or choose a priced replacement.`,
  );
}

async function readBudgetedVirtualModelUsage(
  client: QueryClient,
  virtualModelId: string,
): Promise<BudgetedVirtualModelUsageRow> {
  const result = await client.query<BudgetedVirtualModelUsageRow>(
    `
      select virtual_models.name,
             virtual_models.display_name,
             count(distinct agent_api_keys.id) filter (where agent_limits.id is not null)::integer as budgeted_agent_api_key_count
      from virtual_models
      left join agent_api_keys
        on agent_api_keys.enabled = true
       and (
            agent_api_keys.default_virtual_model_id = virtual_models.id
            or exists (
              select 1
              from agent_api_key_virtual_models
              where agent_api_key_virtual_models.agent_api_key_id = agent_api_keys.id
                and agent_api_key_virtual_models.virtual_model_id = virtual_models.id
            )
       )
      left join agent_limits
        on agent_limits.agent_api_key_id = agent_api_keys.id
       and agent_limits.enabled = true
       and agent_limits.limit_type = 'budget'
       and agent_limits.unit = 'usd'
      where virtual_models.id = $1
      group by virtual_models.id, virtual_models.name, virtual_models.display_name
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
             route_policies.virtual_model_id::text,
             virtual_models.name as virtual_model_name,
             virtual_models.display_name as virtual_model_display_name
      from route_policies
      join virtual_models on virtual_models.id = route_policies.virtual_model_id
      where route_policies.id = $1
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
  const candidateInputs = [
    ...routePolicy.primaryProviderModelIds.map((providerModelId) => ({
      isFallback: false,
      providerModelId,
    })),
    ...routePolicy.fallbackProviderModelIds.map((providerModelId) => ({
      isFallback: true,
      providerModelId,
    })),
  ];
  const candidateRows: ConsoleRoutePolicyCandidate[] = [];

  for (const [index, candidate] of candidateInputs.entries()) {
    const result = await client.query<CandidateRow>(
      `
        with inserted as (
          insert into route_policy_candidates (
            id,
            route_policy_id,
            provider_model_id,
            candidate_order,
            is_fallback
          )
          values ($1, $2, $3, $4, $5)
          returning route_policy_id,
                    provider_model_id,
                    candidate_order,
                    is_fallback
        )
        select inserted.route_policy_id::text,
               provider_models.id::text as id,
               providers.id::text as provider_id,
               providers.provider_key,
               providers.display_name as provider_display_name,
               providers.enabled as provider_enabled,
               provider_models.model_id,
               provider_models.display_name as model_display_name,
               provider_models.availability,
               provider_models.manual_input_usd_per_million_tokens::text
                 as price_override_input_usd_per_million_tokens,
               provider_models.manual_cached_input_usd_per_million_tokens::text
                 as price_override_cached_input_usd_per_million_tokens,
               provider_models.manual_output_usd_per_million_tokens::text
                 as price_override_output_usd_per_million_tokens,
               provider_models.manual_price_updated_at as price_override_updated_at,
               latest_provider_model_price.input_usd_per_million_tokens::text
                 as price_sync_input_usd_per_million_tokens,
               latest_provider_model_price.cached_input_usd_per_million_tokens::text
                 as price_sync_cached_input_usd_per_million_tokens,
               latest_provider_model_price.output_usd_per_million_tokens::text
                 as price_sync_output_usd_per_million_tokens,
               latest_provider_model_price.price_version as price_sync_price_version,
               latest_provider_model_price.source_url as price_sync_source_url,
               latest_provider_model_price.synced_at as price_sync_synced_at,
               inserted.candidate_order,
               inserted.is_fallback
        from inserted
        join provider_models on provider_models.id = inserted.provider_model_id
        join providers on providers.id = provider_models.provider_id
        left join lateral (
          select input_usd_per_million_tokens,
                 cached_input_usd_per_million_tokens,
                 output_usd_per_million_tokens,
                 price_version,
                 source_url,
                 synced_at
          from provider_models_price
          where lower(provider_models_price.provider_key) = lower(providers.provider_key)
            and provider_models_price.model_id = provider_models.model_id
          order by case provider_models_price.source
                     when 'models.dev' then 0
                     when 'litellm' then 1
                     else 2
                   end,
                   synced_at desc,
                   updated_at desc
          limit 1
        ) latest_provider_model_price on true
      `,
      [randomUUID(), routePolicyId, candidate.providerModelId, index + 1, candidate.isFallback],
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
        throw new Error("Route policy candidate provider model id is invalid.");
      }
      return value;
    });
}

function isRoutePolicyStrategy(value: string | null | undefined): value is RoutePolicyStrategy {
  return routePolicyStrategies.includes(value as RoutePolicyStrategy);
}

function isWarningHealthStatus(value: string | null | undefined): value is string {
  return value === "degraded" || value === "unhealthy";
}

function formatRoutePolicyHealthStatus(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
    order by providers.display_name, provider_models.display_name
  `;
}

function providerModelOptionsSelectSql(): string {
  return `
    select provider_models.id::text,
           providers.id::text as provider_id,
           providers.provider_key,
           providers.display_name as provider_display_name,
           providers.enabled as provider_enabled,
           provider_models.model_id,
           provider_models.display_name as model_display_name,
           provider_models.availability,
           provider_models.manual_input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
           provider_models.manual_cached_input_usd_per_million_tokens::text as price_override_cached_input_usd_per_million_tokens,
           provider_models.manual_output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
           provider_models.manual_price_updated_at as price_override_updated_at,
           latest_provider_model_price.input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
           latest_provider_model_price.cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
           latest_provider_model_price.output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
           latest_provider_model_price.price_version as price_sync_price_version,
           latest_provider_model_price.source_url as price_sync_source_url,
           latest_provider_model_price.synced_at as price_sync_synced_at
    from provider_models
    join providers on providers.id = provider_models.provider_id
    left join lateral (
      select input_usd_per_million_tokens,
             cached_input_usd_per_million_tokens,
             output_usd_per_million_tokens,
             price_version,
             source_url,
             synced_at
      from provider_models_price
      where lower(provider_models_price.provider_key) = lower(providers.provider_key)
        and provider_models_price.model_id = provider_models.model_id
      order by case provider_models_price.source
                 when 'models.dev' then 0
                 when 'litellm' then 1
                 else 2
               end,
               synced_at desc,
               updated_at desc
      limit 1
    ) latest_provider_model_price on true
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
  const primaryCandidates = candidates.filter((candidate) => !candidate.isFallback);
  const fallbackCandidates = candidates.filter((candidate) => candidate.isFallback);
  return {
    candidates,
    fallbackCandidates,
    id: row.id,
    primaryCandidates,
    routeReason: buildRouteReasonMetadata({
      fallbackCandidateCount: fallbackCandidates.length,
      primaryCandidateCount: primaryCandidates.length,
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
    isFallback: row.is_fallback,
  };
}

function rowToProviderModelOption(row: ProviderModelOptionRow): ConsoleProviderModelOption {
  const price = resolveEffectiveModelTokenPrice({
    manualOverride: rowToManualPriceOverride(row),
    modelId: row.model_id,
    providerKey: row.provider_key,
    syncedPrice: rowToSyncedPriceSnapshot(row),
  });
  const priceStatusLabel = formatProviderModelPriceStatusLabel(price);

  return {
    availability: row.availability,
    id: row.id,
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
    providerDisplayName: row.provider_display_name,
    providerEnabled: row.provider_enabled,
    providerId: row.provider_id,
    providerKey: row.provider_key,
  };
}

function rowToManualPriceOverride(row: ProviderModelOptionRow): ManualPriceOverride | null {
  if (
    !row.price_override_input_usd_per_million_tokens ||
    !row.price_override_output_usd_per_million_tokens ||
    !row.price_override_updated_at
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.price_override_cached_input_usd_per_million_tokens === null
        ? null
        : Number(row.price_override_cached_input_usd_per_million_tokens),
    inputUsdPerMillionTokens: Number(row.price_override_input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.price_override_output_usd_per_million_tokens),
    providerKey: row.provider_key,
    updatedAt: row.price_override_updated_at,
  };
}

function rowToSyncedPriceSnapshot(row: ProviderModelOptionRow): SyncedPriceSnapshot | null {
  if (
    !row.price_sync_input_usd_per_million_tokens ||
    !row.price_sync_output_usd_per_million_tokens ||
    !row.price_sync_price_version ||
    !row.price_sync_synced_at
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.price_sync_cached_input_usd_per_million_tokens === null
        ? null
        : Number(row.price_sync_cached_input_usd_per_million_tokens),
    inputUsdPerMillionTokens: Number(row.price_sync_input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.price_sync_output_usd_per_million_tokens),
    priceVersion: row.price_sync_price_version,
    providerKey: row.provider_key,
    sourceUrl: row.price_sync_source_url,
    syncedAt: row.price_sync_synced_at,
  };
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Route Policy was not found.");
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
