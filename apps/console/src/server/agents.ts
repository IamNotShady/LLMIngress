import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type AgentType = "coding" | "desktop" | "terminal" | "ide" | "other";
export type AgentIntegrationPlatform =
  | "claude-code"
  | "codex"
  | "cursor"
  | "github-copilot"
  | "hermes"
  | "openclaw"
  | "opencode"
  | "other";
export type AgentDerivedStatus = "high-risk" | "offline" | "online";

export const agentIntegrationPlatforms: readonly AgentIntegrationPlatform[] = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "hermes",
  "openclaw",
  "github-copilot",
  "other",
];

export type AgentFormInput = {
  agentType?: string | null;
  integrationPlatform?: string | null;
  name?: string | null;
  requestLoggingEnabled?: boolean | string | null;
};

export type NormalizedAgentFormInput = {
  agentType: AgentType;
  integrationPlatform: AgentIntegrationPlatform;
  name: string;
  requestLoggingEnabled: boolean;
};

export type ConsoleAgent = NormalizedAgentFormInput & {
  activeApiKeyCount: number;
  enabled: boolean;
  id: string;
  requestAttributionCount: number;
  status: AgentDerivedStatus;
};

type AgentRow = QueryResultRow & {
  active_api_key_count: number;
  agent_type: AgentType;
  enabled: boolean;
  id: string;
  integration_platform: AgentIntegrationPlatform;
  latest_request_at: Date | null;
  limit_usage_ratio: number | string | null;
  name: string;
  recent_failure_count: number;
  recent_request_count: number;
  request_attribution_count: number;
  request_logging_enabled: boolean;
  unhealthy_reachable_provider_count: number;
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
  const integrationPlatform = (input.integrationPlatform ?? "other").trim().toLowerCase();

  if (!name) {
    throw new Error("Agent name is required.");
  }
  if (!isAgentType(agentType)) {
    throw new Error("Agent type must be coding, desktop, terminal, ide, or other.");
  }
  if (!isAgentIntegrationPlatform(integrationPlatform)) {
    throw new Error(
      "Agent integration platform must be codex, claude-code, cursor, opencode, hermes, openclaw, github-copilot, or other.",
    );
  }

  return {
    agentType,
    integrationPlatform,
    name,
    requestLoggingEnabled: normalizeRequestLoggingEnabled(input.requestLoggingEnabled),
  };
}

export function deriveAgentStatus(input: {
  latestRequestAt?: Date | string | null;
  limitUsageRatio?: number | null;
  now?: Date;
  onlineWindowMs?: number;
  recentFailureCount?: number;
  recentRequestCount?: number;
  unhealthyReachableProviderCount?: number;
}): AgentDerivedStatus {
  const recentRequestCount = input.recentRequestCount ?? 0;
  const recentFailureCount = input.recentFailureCount ?? 0;
  const unhealthyReachableProviderCount = input.unhealthyReachableProviderCount ?? 0;
  const limitUsageRatio = input.limitUsageRatio ?? 0;

  if (
    unhealthyReachableProviderCount > 0 ||
    limitUsageRatio >= 1 ||
    (recentRequestCount >= 5 && recentFailureCount / recentRequestCount >= 0.5)
  ) {
    return "high-risk";
  }

  if (!input.latestRequestAt) {
    return "offline";
  }

  const latestRequestAt =
    input.latestRequestAt instanceof Date ? input.latestRequestAt : new Date(input.latestRequestAt);
  const now = input.now ?? new Date();
  const onlineWindowMs = input.onlineWindowMs ?? 15 * 60 * 1000;
  return now.getTime() - latestRequestAt.getTime() <= onlineWindowMs ? "online" : "offline";
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
               agents.integration_platform,
               agents.request_logging_enabled,
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
               ) as request_attribution_count,
               (
                 select max(request_activity.started_at)
                 from request_activity
                 join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                 where agent_api_keys.agent_id = agents.id
               ) as latest_request_at,
               (
                 select count(*)::integer
                 from request_activity
                 join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                 where agent_api_keys.agent_id = agents.id
                   and request_activity.started_at >= now() - interval '1 hour'
               ) as recent_request_count,
               (
                 select count(*)::integer
                 from request_activity
                 join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                 where agent_api_keys.agent_id = agents.id
                   and request_activity.status = 'failed'
                   and request_activity.started_at >= now() - interval '1 hour'
               ) as recent_failure_count,
               (
                 select count(distinct provider_health_summary.id)::integer
                 from agent_api_keys
                 join agent_api_key_virtual_models
                   on agent_api_key_virtual_models.agent_api_key_id = agent_api_keys.id
                 join route_policies
                   on route_policies.virtual_model_id =
                     agent_api_key_virtual_models.virtual_model_id
                 join route_policy_candidates
                   on route_policy_candidates.route_policy_id = route_policies.id
                 join provider_models
                   on provider_models.id = route_policy_candidates.provider_model_id
                 join provider_health_summary
                   on provider_health_summary.provider_id = provider_models.provider_id
                  and (
                    provider_health_summary.provider_model_id is null
                    or provider_health_summary.provider_model_id = provider_models.id
                  )
                 where agent_api_keys.agent_id = agents.id
                   and agent_api_keys.enabled = true
                   and provider_health_summary.status = 'unhealthy'
               ) as unhealthy_reachable_provider_count,
               greatest(
                 coalesce(
                   (
                     select max(
                       (
                         (
                           budget_periods.cost_used_usd + budget_periods.reserved_cost_usd
                         ) / nullif(agent_limits.limit_value, 0)
                       )::double precision
                     )
                     from agent_api_keys
                     join agent_limits on agent_limits.agent_api_key_id = agent_api_keys.id
                     join budget_periods
                       on budget_periods.agent_api_key_id = agent_api_keys.id
                      and budget_periods.period_type = agent_limits.period
                     where agent_api_keys.agent_id = agents.id
                       and agent_api_keys.enabled = true
                       and agent_limits.enabled = true
                       and agent_limits.limit_type = 'budget'
                       and now() >= budget_periods.period_start
                       and now() < budget_periods.period_end
                   ),
                   0
                 ),
                 coalesce(
                   (
                     select max(
                       (
                         rate_limit_windows.request_count::numeric
                         / nullif(agent_limits.limit_value, 0)
                       )::double precision
                     )
                     from agent_api_keys
                     join agent_limits on agent_limits.agent_api_key_id = agent_api_keys.id
                     join rate_limit_windows
                       on rate_limit_windows.agent_api_key_id = agent_api_keys.id
                      and rate_limit_windows.limit_type = agent_limits.limit_type
                     where agent_api_keys.agent_id = agents.id
                       and agent_api_keys.enabled = true
                       and agent_limits.enabled = true
                       and agent_limits.limit_type = 'rpm'
                       and agent_limits.period = 'minute'
                       and now() >= rate_limit_windows.window_start
                       and now() < rate_limit_windows.window_end
                   ),
                   0
                 ),
                 coalesce(
                   (
                     select max(
                       (
                         rate_limit_windows.token_count::numeric
                         / nullif(agent_limits.limit_value, 0)
                       )::double precision
                     )
                     from agent_api_keys
                     join agent_limits on agent_limits.agent_api_key_id = agent_api_keys.id
                     join rate_limit_windows
                       on rate_limit_windows.agent_api_key_id = agent_api_keys.id
                      and rate_limit_windows.limit_type = agent_limits.limit_type
                     where agent_api_keys.agent_id = agents.id
                       and agent_api_keys.enabled = true
                       and agent_limits.enabled = true
                       and agent_limits.limit_type = 'tpm'
                       and agent_limits.period = 'minute'
                       and now() >= rate_limit_windows.window_start
                       and now() < rate_limit_windows.window_end
                   ),
                   0
                 )
               ) as limit_usage_ratio
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
          insert into agents (
            id,
            name,
            agent_type,
            integration_platform,
            request_logging_enabled,
            enabled
          )
          values ($1, $2, $3, $4, $5, true)
          returning id::text,
                    name,
                    agent_type,
                    integration_platform,
                    request_logging_enabled,
                    enabled,
                    0::integer as active_api_key_count,
                    0::integer as request_attribution_count,
                    null::timestamptz as latest_request_at,
                    0::integer as recent_request_count,
                    0::integer as recent_failure_count,
                    0::integer as unhealthy_reachable_provider_count,
                    0::double precision as limit_usage_ratio
        `,
        [
          agentId,
          input.agent.name,
          input.agent.agentType,
          input.agent.integrationPlatform,
          input.agent.requestLoggingEnabled,
        ],
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
              integration_platform = $4,
              request_logging_enabled = $5,
              updated_at = now()
          where id = $1
          returning id::text,
                    name,
                    agent_type,
                    integration_platform,
                    request_logging_enabled,
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
                    ) as request_attribution_count,
                    (
                      select max(request_activity.started_at)
                      from request_activity
                      join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                      where agent_api_keys.agent_id = agents.id
                    ) as latest_request_at,
                    (
                      select count(*)::integer
                      from request_activity
                      join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                      where agent_api_keys.agent_id = agents.id
                        and request_activity.started_at >= now() - interval '1 hour'
                    ) as recent_request_count,
                    (
                      select count(*)::integer
                      from request_activity
                      join agent_api_keys on agent_api_keys.id = request_activity.agent_api_key_id
                      where agent_api_keys.agent_id = agents.id
                        and request_activity.status = 'failed'
                        and request_activity.started_at >= now() - interval '1 hour'
                    ) as recent_failure_count,
                    0::integer as unhealthy_reachable_provider_count,
                    0::double precision as limit_usage_ratio
        `,
        [
          input.id,
          input.agent.name,
          input.agent.agentType,
          input.agent.integrationPlatform,
          input.agent.requestLoggingEnabled,
        ],
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
  const limitUsageRatio = readNumber(row.limit_usage_ratio);

  return {
    activeApiKeyCount: row.active_api_key_count,
    agentType: row.agent_type,
    enabled: row.enabled,
    id: row.id,
    integrationPlatform: row.integration_platform,
    name: row.name,
    requestAttributionCount: row.request_attribution_count,
    requestLoggingEnabled: row.request_logging_enabled,
    status: deriveAgentStatus({
      latestRequestAt: row.latest_request_at,
      limitUsageRatio,
      recentFailureCount: row.recent_failure_count,
      recentRequestCount: row.recent_request_count,
      unhealthyReachableProviderCount: row.unhealthy_reachable_provider_count,
    }),
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

function isAgentIntegrationPlatform(value: string): value is AgentIntegrationPlatform {
  return agentIntegrationPlatforms.includes(value as AgentIntegrationPlatform);
}

function normalizeRequestLoggingEnabled(value: boolean | string | null | undefined): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "enabled", "on", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "disabled", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("Request logging setting must be enabled or disabled.");
}

function readNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
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
