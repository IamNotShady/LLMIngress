import { randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import {
  consoleConflictError,
  consoleNotFoundError,
  consoleValidationError,
} from "./console-operation-error.ts";

export type VirtualModelFormInput = {
  description?: string | null;
  name?: string | null;
};

export type NormalizedVirtualModelFormInput = {
  description: string;
  name: string;
};

export type ConsoleVirtualModel = NormalizedVirtualModelFormInput & {
  allowedAgentCount: number;
  cost24hUsd: string | null;
  defaultAgentCount: number;
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
  allowedAgentCount: number;
  defaultAgentCount: number;
  routePolicyCount: number;
};

type VirtualModelRow = {
  allowed_agent_count: number;
  cost_24h_usd: string | null;
  default_agent_count: number;
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
  allowed_agent_count: number;
  default_agent_count: number;
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
  if (input.routePolicyCount > 0) {
    return "Cannot delete Virtual Model referenced by a route policy.";
  }
  if (input.defaultAgentCount > 0) {
    return "Cannot delete Virtual Model used as an Agent default.";
  }
  if (input.allowedAgentCount > 0) {
    return "Cannot delete Virtual Model allowed by an Agent.";
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

export async function createVirtualModel(input: {
  databaseUrl?: string;
  virtualModel: NormalizedVirtualModelFormInput;
}): Promise<ConsoleVirtualModel> {
  const virtualModelId = randomUUID();
  let virtualModel: ConsoleVirtualModel | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create virtual model ${input.virtualModel.name}`,
    changes: [{ table: "virtual_models", recordId: virtualModelId }],
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
                    0::integer as default_agent_count,
                    0::integer as allowed_agent_count,
                    0::integer as request_count_total,
                    0::integer as failure_count_total,
                    0::integer as request_count_24h,
                    0::numeric(20, 8)::text as cost_24h_usd
        `,
        [virtualModelId, input.virtualModel.name, input.virtualModel.description],
      );
      virtualModel = rowToConsoleVirtualModel(requireRow(result.rows[0]));
    },
  });

  return requireSavedVirtualModel(virtualModel);
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
      await assertVirtualModelExists(client, input.id);
      await assertVirtualModelNameAvailable(client, input.virtualModel.name, input.id);
      const result = await client.query<VirtualModelRow>(
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
                      from agents
                      where agents.default_virtual_model_id = virtual_models.id
                    ) as default_agent_count,
                    (
                      select count(*)::integer
                      from agent_virtual_models
                      where agent_virtual_models.virtual_model_id = virtual_models.id
                    ) as allowed_agent_count,
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
      virtualModel = rowToConsoleVirtualModel(requireRow(result.rows[0]));
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
               from agents
               where agents.default_virtual_model_id = $1
                 and agents.deleted_at is null
             ) as default_agent_count,
             (
               select count(*)::integer
               from agent_virtual_models
               join agents on agents.id = agent_virtual_models.agent_id
               where agent_virtual_models.virtual_model_id = $1
                 and agents.deleted_at is null
             ) as allowed_agent_count
    `,
    [id],
  );
  const row = requireRow(result.rows[0]);
  return {
    allowedAgentCount: row.allowed_agent_count,
    defaultAgentCount: row.default_agent_count,
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
             from agents
             where agents.default_virtual_model_id = virtual_models.id
               and agents.deleted_at is null
           ) as default_agent_count,
           (
             select count(*)::integer
             from agent_virtual_models
             join agents on agents.id = agent_virtual_models.agent_id
             where agent_virtual_models.virtual_model_id = virtual_models.id
               and agents.deleted_at is null
           ) as allowed_agent_count,
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
    order by virtual_models.name
  `;
}

function rowToConsoleVirtualModel(row: VirtualModelRow): ConsoleVirtualModel {
  return {
    allowedAgentCount: row.allowed_agent_count,
    cost24hUsd: row.cost_24h_usd,
    defaultAgentCount: row.default_agent_count,
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
