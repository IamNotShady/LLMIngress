import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type VirtualModelFormInput = {
  displayName?: string | null;
  name?: string | null;
};

export type NormalizedVirtualModelFormInput = {
  displayName: string;
  name: string;
};

export type ConsoleVirtualModel = NormalizedVirtualModelFormInput & {
  allowedAgentCount: number;
  defaultAgentCount: number;
  enabled: boolean;
  id: string;
  routePolicyCount: number;
};

type VirtualModelDependencyCounts = {
  allowedAgentCount: number;
  defaultAgentCount: number;
  routePolicyCount: number;
};

type VirtualModelRow = QueryResultRow & {
  allowed_agent_count: number;
  default_agent_count: number;
  display_name: string;
  enabled: boolean;
  id: string;
  name: string;
  route_policy_count: number;
};

type VirtualModelDependencyRow = QueryResultRow & {
  allowed_agent_count: number;
  default_agent_count: number;
  route_policy_count: number;
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
  const displayName = input.displayName?.trim();
  const name = input.name?.trim().toLowerCase().replaceAll(/\s+/g, "-");

  if (!name) {
    throw new Error("Virtual model name is required.");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      "Virtual model name must use lowercase letters, numbers, dashes, or underscores.",
    );
  }
  if (!displayName) {
    throw new Error("Virtual model display name is required.");
  }

  return { displayName, name };
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

export async function listVirtualModels(databaseUrl: string): Promise<ConsoleVirtualModel[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<VirtualModelRow>(buildVirtualModelListSql());
    return result.rows.map(rowToConsoleVirtualModel);
  });
}

export async function createVirtualModel(input: {
  databaseUrl: string;
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
          insert into virtual_models (id, name, display_name, enabled)
          values ($1, $2, $3, true)
          returning id::text,
                    name,
                    display_name,
                    enabled,
                    0::integer as route_policy_count,
                    0::integer as default_agent_count,
                    0::integer as allowed_agent_count
        `,
        [virtualModelId, input.virtualModel.name, input.virtualModel.displayName],
      );
      virtualModel = rowToConsoleVirtualModel(requireRow(result.rows[0]));
    },
  });

  return requireSavedVirtualModel(virtualModel);
}

export async function updateVirtualModel(input: {
  databaseUrl: string;
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
              display_name = $3,
              updated_at = now()
          where id = $1
          returning id::text,
                    name,
                    display_name,
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
                    ) as allowed_agent_count
        `,
        [input.id, input.virtualModel.name, input.virtualModel.displayName],
      );
      virtualModel = rowToConsoleVirtualModel(requireRow(result.rows[0]));
    },
  });

  return requireSavedVirtualModel(virtualModel);
}

export async function deleteVirtualModel(input: {
  databaseUrl: string;
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
        throw new Error(dependencyError);
      }

      const result = await client.query<{ id: string }>(
        "delete from virtual_models where id = $1 returning id::text",
        [input.id],
      );
      if (!result.rows[0]) {
        throw new Error("Virtual Model was not deleted.");
      }
    },
  });
}

async function assertVirtualModelExists(client: QueryClient, id: string): Promise<void> {
  const result = await client.query("select 1 from virtual_models where id = $1 for update", [id]);
  if (!result.rows[0]) {
    throw new Error("Virtual Model was not found.");
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
        and ($2::uuid is null or id <> $2::uuid)
      limit 1
    `,
    [name, excludingId ?? null],
  );
  if (result.rows[0]) {
    throw new Error("Virtual Model name already exists.");
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
             ) as route_policy_count,
             (
               select count(*)::integer
               from agents
               where agents.default_virtual_model_id = $1
             ) as default_agent_count,
             (
               select count(*)::integer
               from agent_virtual_models
               where agent_virtual_models.virtual_model_id = $1
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
           virtual_models.display_name,
           virtual_models.enabled,
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
           ) as allowed_agent_count
    from virtual_models
    order by virtual_models.name
  `;
}

function rowToConsoleVirtualModel(row: VirtualModelRow): ConsoleVirtualModel {
  return {
    allowedAgentCount: row.allowed_agent_count,
    defaultAgentCount: row.default_agent_count,
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    name: row.name,
    routePolicyCount: row.route_policy_count,
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Virtual Model was not found.");
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
