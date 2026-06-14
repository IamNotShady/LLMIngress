import { randomUUID } from "node:crypto";
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
  provider_display_name: string;
  provider_enabled: boolean;
  provider_id: string;
  provider_key: string;
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
  return candidates
    .filter((candidate) => candidate.availability !== "available")
    .map(
      (candidate) =>
        `Route warning: ${candidate.optionLabel} is ${candidate.availability} and excluded from Gateway routing.`,
    );
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
                       route_policy_candidates.candidate_order,
                       route_policy_candidates.is_fallback
                from route_policy_candidates
                join provider_models on provider_models.id = route_policy_candidates.provider_model_id
                join providers on providers.id = provider_models.provider_id
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
        insert into route_policy_candidates (
          id,
          route_policy_id,
          provider_model_id,
          candidate_order,
          is_fallback
        )
        values ($1, $2, $3, $4, $5)
        returning route_policy_id::text,
                  provider_model_id::text as id,
                  (
                    select provider_models.provider_id::text
                    from provider_models
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as provider_id,
                  (
                    select providers.provider_key
                    from provider_models
                    join providers on providers.id = provider_models.provider_id
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as provider_key,
                  (
                    select providers.display_name
                    from provider_models
                    join providers on providers.id = provider_models.provider_id
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as provider_display_name,
                  (
                    select providers.enabled
                    from provider_models
                    join providers on providers.id = provider_models.provider_id
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as provider_enabled,
                  (
                    select provider_models.model_id
                    from provider_models
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as model_id,
                  (
                    select provider_models.display_name
                    from provider_models
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as model_display_name,
                  (
                    select provider_models.availability
                    from provider_models
                    where provider_models.id = route_policy_candidates.provider_model_id
                  ) as availability,
                  candidate_order,
                  is_fallback
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function providerModelOptionsSql(): string {
  return `
    select provider_models.id::text,
           providers.id::text as provider_id,
           providers.provider_key,
           providers.display_name as provider_display_name,
           providers.enabled as provider_enabled,
           provider_models.model_id,
           provider_models.display_name as model_display_name,
           provider_models.availability
    from provider_models
    join providers on providers.id = provider_models.provider_id
    order by providers.display_name, provider_models.display_name
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
  return {
    availability: row.availability,
    id: row.id,
    modelDisplayName: row.model_display_name,
    modelId: row.model_id,
    optionLabel: `${row.provider_display_name} - ${row.model_display_name} (${row.model_id})`,
    providerDisplayName: row.provider_display_name,
    providerEnabled: row.provider_enabled,
    providerId: row.provider_id,
    providerKey: row.provider_key,
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
