import { randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import {
  consoleConflictError,
  consoleNotFoundError,
  consoleValidationError,
} from "./console-operation-error.ts";
import {
  type ConsoleRoutePolicy,
  createRoutePolicyWithClient,
  type NormalizedRoutePolicyFormInput,
  normalizeRoutePolicyFormInput,
  type RoutePolicyFormInput,
  updateRoutePolicyWithClient,
} from "./console-route-policies.ts";

export type VirtualModelFormInput = {
  description?: string | null;
  name?: string | null;
};

export type NormalizedVirtualModelFormInput = {
  description: string;
  name: string;
};

export type VirtualModelRouteFormInput = Omit<RoutePolicyFormInput, "virtualModelId">;

export type CreatedVirtualModelWithRoute = {
  routePolicy: ConsoleRoutePolicy;
  virtualModel: ConsoleVirtualModel;
};

export type ConsoleVirtualModel = NormalizedVirtualModelFormInput & {
  allowedApiKeyCount: number;
  cost24hUsd: string | null;
  defaultApiKeyCount: number;
  enabled: boolean;
  failureCountTotal: number;
  id: string;
  requestCountTotal: number;
  requestCount24h: number;
  routePolicyCount: number;
};

export type ConsoleVirtualModelFallbackBreakdown = {
  name: string;
  value: number;
};

type VirtualModelDependencyCounts = {
  allowedApiKeyCount: number;
  defaultApiKeyCount: number;
  routePolicyCount: number;
};

type VirtualModelRow = {
  allowed_api_key_count: number;
  cost_24h_usd: string | null;
  default_api_key_count: number;
  display_name: string;
  enabled: boolean;
  failure_count_total: number;
  id: string;
  name: string;
  request_count_total: number;
  request_count_24h: number;
  route_policy_count: number;
};

type VirtualModelDependencyRow = {
  allowed_api_key_count: number;
  default_api_key_count: number;
  route_policy_count: number;
};

type VirtualModelFallbackBreakdownRow = {
  name: string;
  value: number | string;
};

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export function normalizeVirtualModelFormInput(
  input: VirtualModelFormInput,
): NormalizedVirtualModelFormInput {
  const description = input.description?.trim();
  const name = input.name?.trim().toLowerCase().replaceAll(/\s+/g, "-");

  if (!name) {
    throw consoleValidationError("Virtual model name is required.", "virtual_model_name_required", {
      field: "name",
    });
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw consoleValidationError(
      "Virtual model name must use lowercase letters, numbers, dashes, or underscores.",
      "virtual_model_name_invalid",
      { field: "name" },
    );
  }
  if (!description) {
    throw consoleValidationError(
      "Virtual model description is required.",
      "virtual_model_description_required",
      { field: "description" },
    );
  }

  return { description, name };
}

export function getVirtualModelDeleteDependencyError(
  input: VirtualModelDependencyCounts,
): string | null {
  if (input.defaultApiKeyCount > 0) {
    return "Cannot delete Virtual Model used as an ApiKey default.";
  }
  if (input.allowedApiKeyCount > 0) {
    return "Cannot delete Virtual Model allowed by an ApiKey.";
  }
  return null;
}

export async function listVirtualModels(databaseUrl?: string): Promise<ConsoleVirtualModel[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<VirtualModelRow>(buildVirtualModelListSql());
    return result.rows.map(rowToConsoleVirtualModel);
  });
}

export async function listVirtualModelFallbackBreakdown(input: {
  databaseUrl?: string;
  virtualModelId: string;
}): Promise<ConsoleVirtualModelFallbackBreakdown[]> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<VirtualModelFallbackBreakdownRow>(
      `
        with vm_requests as (
          select request_activity.id
          from request_activity
          where request_activity.virtual_model_id = $1::uuid
            and request_activity.started_at >= now() - interval '24 hours'
        ),
        fallback_request_counts as (
          select fallback_events.request_activity_id,
                 count(*)::integer as fallback_count
          from fallback_events
          join vm_requests on vm_requests.id = fallback_events.request_activity_id
          group by fallback_events.request_activity_id
        ),
        no_fallback as (
          select 'No fallback triggered'::text as name,
                 count(vm_requests.id)::integer as value
          from vm_requests
          left join fallback_request_counts
            on fallback_request_counts.request_activity_id = vm_requests.id
          where fallback_request_counts.request_activity_id is null
        ),
        fallback_models as (
          select coalesce(provider_models.display_name, provider_models.model_id, 'Unknown model')
                   as name,
                 count(fallback_events.id)::integer as value
          from fallback_events
          join vm_requests on vm_requests.id = fallback_events.request_activity_id
          left join provider_models on provider_models.id = fallback_events.provider_model_id
          group by name
        )
        select name, value from no_fallback where value > 0
        union all
        select name, value from fallback_models where value > 0
        order by value desc, name asc
      `,
      [input.virtualModelId],
    );
    return result.rows.map((row) => ({
      name: row.name,
      value: Number(row.value),
    }));
  });
}

export async function createVirtualModelWithRoute(input: {
  databaseUrl?: string;
  routePolicy: VirtualModelRouteFormInput;
  virtualModel: NormalizedVirtualModelFormInput;
}): Promise<CreatedVirtualModelWithRoute> {
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const normalizedRoutePolicy = normalizeRoutePolicyFormInput({
    ...input.routePolicy,
    virtualModelId,
  });
  let virtualModel: ConsoleVirtualModel | undefined;
  let routePolicy: ConsoleRoutePolicy | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create virtual model ${input.virtualModel.name} with route`,
    changes: [
      { table: "virtual_models", recordId: virtualModelId },
      { table: "route_policies", recordId: routePolicyId },
      { table: "route_policy_candidates" },
    ],
    write: async (client) => {
      await assertVirtualModelNameAvailable(client, input.virtualModel.name);
      const result = await client.query<VirtualModelRow>(
        `
          insert into virtual_models (id, name, description, enabled)
          values ($1, $2, $3, true)
          returning id::text,
                    name,
                    description as display_name,
                    enabled,
                    0::integer as route_policy_count,
                    0::integer as default_api_key_count,
                    0::integer as allowed_api_key_count,
                    0::integer as request_count_total,
                    0::integer as failure_count_total,
                    0::integer as request_count_24h,
                    0::numeric(20, 8)::text as cost_24h_usd
        `,
        [virtualModelId, input.virtualModel.name, input.virtualModel.description],
      );
      virtualModel = rowToConsoleVirtualModel(requireRow(result.rows[0]));
      routePolicy = await createRoutePolicyWithClient({
        client,
        routePolicy: normalizedRoutePolicy,
        routePolicyId,
      });
    },
  });

  return {
    routePolicy: requireSavedRoutePolicy(routePolicy),
    virtualModel: requireSavedVirtualModel(virtualModel),
  };
}

export async function updateVirtualModel(input: {
  databaseUrl?: string;
  id: string;
  virtualModel: NormalizedVirtualModelFormInput;
}): Promise<ConsoleVirtualModel> {
  let virtualModel: ConsoleVirtualModel | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update virtual model ${input.id}`,
    changes: [{ table: "virtual_models", recordId: input.id }],
    write: async (client) => {
      virtualModel = await updateVirtualModelWithClient({
        client,
        id: input.id,
        virtualModel: input.virtualModel,
      });
    },
  });

  return requireSavedVirtualModel(virtualModel);
}

/**
 * The write half on a caller's client, so a save that changes both the model
 * and its route commits or fails as one.
 */
export async function updateVirtualModelWithClient(input: {
  client: QueryClient;
  id: string;
  virtualModel: NormalizedVirtualModelFormInput;
}): Promise<ConsoleVirtualModel> {
  await assertVirtualModelExists(input.client, input.id);
  await assertVirtualModelNameAvailable(input.client, input.virtualModel.name, input.id);
  const result = await input.client.query<VirtualModelRow>(
    `
          update virtual_models
          set name = $2,
              description = $3,
              updated_at = now()
          where id = $1
          returning id::text,
                    name,
                    description as display_name,
                    enabled,
                    (
                      select count(*)::integer
                      from route_policies
                      where route_policies.virtual_model_id = virtual_models.id
                    ) as route_policy_count,
                    (
                      select count(*)::integer
                      from api_keys
                      where api_keys.default_virtual_model_id = virtual_models.id
                    ) as default_api_key_count,
                    (
                      select count(*)::integer
                      from api_key_virtual_models
                      where api_key_virtual_models.virtual_model_id = virtual_models.id
                    ) as allowed_api_key_count,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.virtual_model_id = virtual_models.id
                    ) as request_count_total,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.virtual_model_id = virtual_models.id
                        and request_activity.status = 'failed'
                    ) as failure_count_total,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.virtual_model_id = virtual_models.id
                        and request_activity.started_at >= now() - interval '24 hours'
                    ) as request_count_24h,
                    (
                      select coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
                      from request_activity
                      left join request_costs
                        on request_costs.request_activity_id = request_activity.id
                      where request_activity.virtual_model_id = virtual_models.id
                        and request_activity.started_at >= now() - interval '24 hours'
                    ) as cost_24h_usd
        `,
    [input.id, input.virtualModel.name, input.virtualModel.description],
  );
  return rowToConsoleVirtualModel(requireRow(result.rows[0]));
}

/**
 * A model and its route saved together. The editor puts both behind one button,
 * so a route the contract refuses has to take the rename down with it — two
 * publishes would leave the operator reading "refused" over a model that had
 * already been renamed.
 */
export async function updateVirtualModelWithRoute(input: {
  databaseUrl?: string;
  id: string;
  routePolicy: NormalizedRoutePolicyFormInput | null;
  routePolicyId: string | null;
  virtualModel: NormalizedVirtualModelFormInput;
}): Promise<ConsoleVirtualModel> {
  let virtualModel: ConsoleVirtualModel | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update virtual model ${input.id}`,
    changes: [{ table: "virtual_models", recordId: input.id }],
    write: async (client) => {
      virtualModel = await updateVirtualModelWithClient({
        client,
        id: input.id,
        virtualModel: input.virtualModel,
      });
      if (!input.routePolicy) {
        return;
      }
      if (input.routePolicyId) {
        await updateRoutePolicyWithClient({
          client,
          id: input.routePolicyId,
          routePolicy: input.routePolicy,
        });
        return;
      }
      await createRoutePolicyWithClient({
        client,
        routePolicy: input.routePolicy,
        routePolicyId: randomUUID(),
      });
    },
  });

  return requireSavedVirtualModel(virtualModel);
}

export async function deleteVirtualModel(input: {
  databaseUrl?: string;
  id: string;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete virtual model ${input.id}`,
    changes: [{ table: "virtual_models", recordId: input.id }],
    write: async (client) => {
      await assertVirtualModelExists(client, input.id);
      const dependencyError = getVirtualModelDeleteDependencyError(
        await readVirtualModelDependencyCounts(client, input.id),
      );
      if (dependencyError) {
        throw consoleConflictError(dependencyError, "virtual_model_dependency_conflict", {
          virtualModelId: input.id,
        });
      }

      await client.query(
        `
          update route_policies
          set deleted_at = now(),
              updated_at = now()
          where virtual_model_id = $1
            and deleted_at is null
        `,
        [input.id],
      );

      const result = await client.query<{ id: string }>(
        `
          update virtual_models
          set deleted_at = now(),
              enabled = false,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text
        `,
        [input.id],
      );
      if (!result.rows[0]) {
        throw new Error("Virtual Model was not deleted.");
      }
    },
  });
}

async function assertVirtualModelExists(client: QueryClient, id: string): Promise<void> {
  const result = await client.query(
    "select 1 from virtual_models where id = $1 and deleted_at is null for update",
    [id],
  );
  if (!result.rows[0]) {
    throw consoleNotFoundError("Virtual Model was not found.", "virtual_model_not_found", {
      virtualModelId: id,
    });
  }
}

async function assertVirtualModelNameAvailable(
  client: QueryClient,
  name: string,
  excludingId?: string,
): Promise<void> {
  const result = await client.query(
    `
      select 1
      from virtual_models
      where name = $1
        and deleted_at is null
        and ($2::uuid is null or id <> $2::uuid)
      limit 1
    `,
    [name, excludingId ?? null],
  );
  if (result.rows[0]) {
    throw consoleConflictError(
      "Virtual Model name already exists.",
      "virtual_model_name_conflict",
      {
        field: "name",
        name,
      },
    );
  }
}

async function readVirtualModelDependencyCounts(
  client: QueryClient,
  id: string,
): Promise<VirtualModelDependencyCounts> {
  const result = await client.query<VirtualModelDependencyRow>(
    `
      select (
               select count(*)::integer
               from route_policies
               where route_policies.virtual_model_id = $1
                 and route_policies.deleted_at is null
             ) as route_policy_count,
             (
               select count(*)::integer
               from api_keys
               where api_keys.default_virtual_model_id = $1
                 and api_keys.deleted_at is null
             ) as default_api_key_count,
             (
               select count(*)::integer
               from api_key_virtual_models
               join api_keys on api_keys.id = api_key_virtual_models.api_key_id
               where api_key_virtual_models.virtual_model_id = $1
                 and api_keys.deleted_at is null
             ) as allowed_api_key_count
    `,
    [id],
  );
  const row = requireRow(result.rows[0]);
  return {
    allowedApiKeyCount: row.allowed_api_key_count,
    defaultApiKeyCount: row.default_api_key_count,
    routePolicyCount: row.route_policy_count,
  };
}

function buildVirtualModelListSql(): string {
  return `
    select virtual_models.id::text,
           virtual_models.name,
           virtual_models.description as display_name,
           virtual_models.enabled,
           (
             select count(*)::integer
             from route_policies
             where route_policies.virtual_model_id = virtual_models.id
               and route_policies.deleted_at is null
           ) as route_policy_count,
           (
             select count(*)::integer
             from api_keys
             where api_keys.default_virtual_model_id = virtual_models.id
               and api_keys.deleted_at is null
           ) as default_api_key_count,
           (
             select count(*)::integer
             from api_key_virtual_models
             join api_keys on api_keys.id = api_key_virtual_models.api_key_id
             where api_key_virtual_models.virtual_model_id = virtual_models.id
               and api_keys.deleted_at is null
           ) as allowed_api_key_count,
           (
             select count(*)::integer
             from request_activity
             where request_activity.virtual_model_id = virtual_models.id
           ) as request_count_total,
           (
             select count(*)::integer
             from request_activity
             where request_activity.virtual_model_id = virtual_models.id
               and request_activity.status = 'failed'
           ) as failure_count_total,
           (
             select count(*)::integer
             from request_activity
             where request_activity.virtual_model_id = virtual_models.id
               and request_activity.started_at >= now() - interval '24 hours'
           ) as request_count_24h,
           (
             select coalesce(sum(request_costs.total_cost_usd), 0)::numeric(20, 8)::text
             from request_activity
             left join request_costs
               on request_costs.request_activity_id = request_activity.id
             where request_activity.virtual_model_id = virtual_models.id
               and request_activity.started_at >= now() - interval '24 hours'
           ) as cost_24h_usd
    from virtual_models
    where virtual_models.deleted_at is null
    order by virtual_models.created_at desc,
             virtual_models.id desc
  `;
}

function rowToConsoleVirtualModel(row: VirtualModelRow): ConsoleVirtualModel {
  return {
    allowedApiKeyCount: row.allowed_api_key_count,
    cost24hUsd: row.cost_24h_usd,
    defaultApiKeyCount: row.default_api_key_count,
    description: row.display_name,
    enabled: row.enabled,
    failureCountTotal: row.failure_count_total,
    id: row.id,
    name: row.name,
    requestCountTotal: row.request_count_total,
    requestCount24h: row.request_count_24h,
    routePolicyCount: row.route_policy_count,
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw consoleNotFoundError("Virtual Model was not found.", "virtual_model_not_found");
  }
  return row;
}

function requireSavedVirtualModel(
  virtualModel: ConsoleVirtualModel | undefined,
): ConsoleVirtualModel {
  if (!virtualModel) {
    throw new Error("Virtual Model was not saved.");
  }
  return virtualModel;
}

function requireSavedRoutePolicy(routePolicy: ConsoleRoutePolicy | undefined): ConsoleRoutePolicy {
  if (!routePolicy) {
    throw new Error("Virtual Model route policy was not saved.");
  }
  return routePolicy;
}

/** One api_key_virtual_models row, resolved for display on both sides. */
export type ConsoleApiKeyVirtualModelGrant = {
  apiKeyId: string;
  apiKeyName: string;
  /** True when this virtual model is the key's default_virtual_model_id. */
  isDefault: boolean;
  virtualModelId: string;
};

export async function listConsoleApiKeyVirtualModelGrants(
  input: { databaseUrl?: string } = {},
): Promise<ConsoleApiKeyVirtualModelGrant[]> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<{
      api_key_id: string;
      api_key_name: string;
      is_default: boolean;
      virtual_model_id: string;
    }>(
      `
        select api_keys.id::text as api_key_id,
               api_keys.name as api_key_name,
               (api_keys.default_virtual_model_id = api_key_virtual_models.virtual_model_id)
                 as is_default,
               api_key_virtual_models.virtual_model_id::text as virtual_model_id
        from api_key_virtual_models
        join api_keys on api_keys.id = api_key_virtual_models.api_key_id
        where api_keys.deleted_at is null
        order by api_keys.name
      `,
    );
    return result.rows.map((row) => ({
      apiKeyId: row.api_key_id,
      apiKeyName: row.api_key_name,
      isDefault: row.is_default ?? false,
      virtualModelId: row.virtual_model_id,
    }));
  });
}
