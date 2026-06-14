import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type AgentType = "coding" | "desktop" | "terminal" | "ide" | "other";

export type AgentFormInput = {
  agentType?: string | null;
  name?: string | null;
};

export type NormalizedAgentFormInput = {
  agentType: AgentType;
  name: string;
};

export type ConsoleAgent = NormalizedAgentFormInput & {
  activeApiKeyCount: number;
  enabled: boolean;
  id: string;
  requestAttributionCount: number;
};

type AgentRow = QueryResultRow & {
  active_api_key_count: number;
  agent_type: AgentType;
  enabled: boolean;
  id: string;
  name: string;
  request_attribution_count: number;
};

type AgentDependencyCounts = {
  activeApiKeyCount: number;
  requestAttributionCount: number;
};

type AgentQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

type AgentDependencyRow = QueryResultRow & {
  active_api_key_count: number;
  request_attribution_count: number;
};

export function normalizeAgentFormInput(input: AgentFormInput): NormalizedAgentFormInput {
  const name = input.name?.trim();
  const agentType = input.agentType?.trim().toLowerCase();

  if (!name) {
    throw new Error("Agent name is required.");
  }
  if (!isAgentType(agentType)) {
    throw new Error("Agent type must be coding, desktop, terminal, ide, or other.");
  }

  return {
    agentType,
    name,
  };
}

export function getAgentDeleteDependencyError(input: AgentDependencyCounts): string | null {
  if (input.activeApiKeyCount > 0) {
    return "Cannot delete agent with active API keys.";
  }
  if (input.requestAttributionCount > 0) {
    return "Cannot delete agent with request attribution.";
  }
  return null;
}

export async function listAgents(databaseUrl: string): Promise<ConsoleAgent[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<AgentRow>(
      `
        select agents.id::text,
               agents.name,
               agents.agent_type,
               agents.enabled,
               (
                 select count(*)::integer
                 from agent_api_keys
                 where agent_api_keys.agent_id = agents.id
                   and agent_api_keys.enabled = true
               ) as active_api_key_count,
               (
                 select count(*)::integer
                 from request_activity
                 join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                 where agent_api_keys.agent_id = agents.id
               ) as request_attribution_count
        from agents
        order by agents.name
      `,
    );
    return result.rows.map(rowToConsoleAgent);
  });
}

export async function createAgent(input: {
  agent: NormalizedAgentFormInput;
  databaseUrl: string;
}): Promise<ConsoleAgent> {
  const agentId = randomUUID();
  let agent: ConsoleAgent | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create agent ${input.agent.name}`,
    changes: [{ table: "agents", recordId: agentId }],
    write: async (client) => {
      const result = await client.query<AgentRow>(
        `
          insert into agents (id, name, agent_type, enabled)
          values ($1, $2, $3, true)
          returning id::text,
                    name,
                    agent_type,
                    enabled,
                    0::integer as active_api_key_count,
                    0::integer as request_attribution_count
        `,
        [agentId, input.agent.name, input.agent.agentType],
      );
      agent = rowToConsoleAgent(requireRow(result.rows[0]));
    },
  });

  return requireSavedAgent(agent);
}

export async function updateAgent(input: {
  agent: NormalizedAgentFormInput;
  databaseUrl: string;
  id: string;
}): Promise<ConsoleAgent> {
  let agent: ConsoleAgent | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update agent ${input.id}`,
    changes: [{ table: "agents", recordId: input.id }],
    write: async (client) => {
      const result = await client.query<AgentRow>(
        `
          update agents
          set name = $2,
              agent_type = $3,
              updated_at = now()
          where id = $1
          returning id::text,
                    name,
                    agent_type,
                    enabled,
                    (
                      select count(*)::integer
                      from agent_api_keys
                      where agent_api_keys.agent_id = agents.id
                        and agent_api_keys.enabled = true
                    ) as active_api_key_count,
                    (
                      select count(*)::integer
                      from request_activity
                      join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                      where agent_api_keys.agent_id = agents.id
                    ) as request_attribution_count
        `,
        [input.id, input.agent.name, input.agent.agentType],
      );
      agent = rowToConsoleAgent(requireRow(result.rows[0]));
    },
  });

  return requireSavedAgent(agent);
}

export async function deleteAgent(input: { databaseUrl: string; id: string }): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete agent ${input.id}`,
    changes: [{ table: "agents", recordId: input.id }],
    write: async (client) => {
      await assertAgentExists(client, input.id);
      const dependencyError = getAgentDeleteDependencyError(
        await readAgentDependencyCounts(client, input.id),
      );
      if (dependencyError) {
        throw new Error(dependencyError);
      }

      await client.query("delete from agent_api_keys where agent_id = $1 and enabled = false", [
        input.id,
      ]);
      const result = await client.query<{ id: string }>(
        "delete from agents where id = $1 returning id::text",
        [input.id],
      );
      if (!result.rows[0]) {
        throw new Error("Agent was not deleted.");
      }
    },
  });
}

async function assertAgentExists(client: AgentQueryClient, agentId: string): Promise<void> {
  const result = await client.query("select 1 from agents where id = $1 for update", [agentId]);
  if (!result.rows[0]) {
    throw new Error("Agent was not found.");
  }
}

async function readAgentDependencyCounts(
  client: AgentQueryClient,
  agentId: string,
): Promise<AgentDependencyCounts> {
  const result = await client.query<AgentDependencyRow>(
    `
      select (
               select count(*)::integer
               from agent_api_keys
               where agent_api_keys.agent_id = $1
                 and agent_api_keys.enabled = true
             ) as active_api_key_count,
             (
               select count(*)::integer
               from request_activity
               join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
               where agent_api_keys.agent_id = $1
             ) as request_attribution_count
    `,
    [agentId],
  );
  const row = requireRow(result.rows[0]);
  return {
    activeApiKeyCount: row.active_api_key_count,
    requestAttributionCount: row.request_attribution_count,
  };
}

function rowToConsoleAgent(row: AgentRow): ConsoleAgent {
  return {
    activeApiKeyCount: row.active_api_key_count,
    agentType: row.agent_type,
    enabled: row.enabled,
    id: row.id,
    name: row.name,
    requestAttributionCount: row.request_attribution_count,
  };
}

function isAgentType(value: string | undefined): value is AgentType {
  return (
    value === "coding" ||
    value === "desktop" ||
    value === "terminal" ||
    value === "ide" ||
    value === "other"
  );
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Agent was not found.");
  }
  return row;
}

function requireSavedAgent(agent: ConsoleAgent | undefined): ConsoleAgent {
  if (!agent) {
    throw new Error("Agent was not saved.");
  }
  return agent;
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
