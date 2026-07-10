import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";

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
  createdAt: Date;
  enabled: boolean;
  hasApiKey: boolean;
  id: string;
  keyPrefix: string | null;
  requestAttributionCount: number;
  status: AgentDerivedStatus;
  updatedAt: Date;
};

export type ConsoleAgentCreateResult = ConsoleAgent & {
  plaintext: string;
};

export type AgentVirtualModel = {
  displayName: string;
  id: string;
  name: string;
};

export type AgentVirtualModelAccess = {
  agentId: string;
  allowedVirtualModels: AgentVirtualModel[];
  defaultVirtualModel: AgentVirtualModel | null;
};

export type AgentVirtualModelAccessInput = {
  allowedVirtualModelIds?: readonly (string | null | undefined)[] | string | null;
  defaultVirtualModelId?: string | null;
  id?: string | null;
};

export type NormalizedAgentVirtualModelAccessInput = {
  allowedVirtualModelIds: string[];
  defaultVirtualModelId: string | null;
  id: string;
};

type AgentRow = {
  agent_type: AgentType;
  created_at: Date;
  enabled: boolean;
  has_api_key: boolean;
  id: string;
  integration_platform: AgentIntegrationPlatform;
  key_prefix: string | null;
  latest_request_at: Date | null;
  limit_usage_ratio: number | string | null;
  name: string;
  recent_failure_count: number;
  recent_request_count: number;
  request_attribution_count: number;
  request_logging_enabled: boolean;
  updated_at: Date;
  unhealthy_reachable_provider_count: number;
};

type AgentDependencyCounts = {
  requestAttributionCount: number;
};

type AgentQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

type AgentVirtualModelAccessBaseRow = {
  agent_id: string;
  default_virtual_model_display_name: string | null;
  default_virtual_model_id: string | null;
  default_virtual_model_name: string | null;
};

type AgentAllowedVirtualModelRow = {
  agent_id: string;
  display_name: string;
  id: string;
  name: string;
};

export type StoredAgentApiKey = {
  keyHash: string;
  keyPrefix: string;
};

const agentApiKeyPrefixLength = 12;

export function generateAgentApiKeyPlaintext(): string {
  return `llmi_${randomBytes(32).toString("base64url")}`;
}

export function buildAgentApiKeyHash(plaintext: string): string {
  return `sha256:v1:${createHash("sha256")
    .update("llmingress:agent-api-key:v1")
    .update(plaintext.trim())
    .digest("base64url")}`;
}

export function prepareAgentApiKeyForStorage(plaintext: string): StoredAgentApiKey {
  const normalized = normalizeAgentApiKeyPlaintext(plaintext);
  return {
    keyHash: buildAgentApiKeyHash(normalized),
    keyPrefix: normalized.slice(0, agentApiKeyPrefixLength),
  };
}

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

export function getAgentDeleteDependencyError(_input: AgentDependencyCounts): string | null {
  return null;
}

export async function listAgents(databaseUrl?: string): Promise<ConsoleAgent[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<AgentRow>(
      `
        select agents.id::text,
               agents.name,
               agents.agent_type,
               agents.integration_platform,
               agents.request_logging_enabled,
               agents.key_prefix,
               agents.enabled,
               agents.created_at,
               agents.updated_at,
               (agents.key_hash is not null) as has_api_key,
               (
                 select count(*)::integer
                 from request_activity
                 where request_activity.agent_id = agents.id
               ) as request_attribution_count,
               (
                 select max(request_activity.started_at)
                 from request_activity
                 where request_activity.agent_id = agents.id
               ) as latest_request_at,
               (
                 select count(*)::integer
                 from request_activity
                 where request_activity.agent_id = agents.id
                   and request_activity.started_at >= now() - interval '1 hour'
               ) as recent_request_count,
               (
                 select count(*)::integer
                 from request_activity
                 where request_activity.agent_id = agents.id
                   and request_activity.status = 'failed'
                   and request_activity.started_at >= now() - interval '1 hour'
               ) as recent_failure_count,
               (
                 select count(distinct provider_health_summary.id)::integer
                 from agent_virtual_models
                 join route_policies
                   on route_policies.virtual_model_id =
                     agent_virtual_models.virtual_model_id
                 join route_policy_candidates
                   on route_policy_candidates.route_policy_id = route_policies.id
                 join provider_models
                   on provider_models.id = route_policy_candidates.provider_model_id
                 join providers
                   on providers.id = provider_models.provider_id
                 join provider_health_summary
                   on provider_health_summary.provider_id = provider_models.provider_id
                  and (
                    provider_health_summary.provider_model_id is null
                    or provider_health_summary.provider_model_id = provider_models.id
                  )
                 where agent_virtual_models.agent_id = agents.id
                   and route_policies.deleted_at is null
                   and providers.deleted_at is null
                   and provider_models.deleted_at is null
                   and provider_health_summary.status in (
                     'unhealthy',
                     'auth_failed',
                     'quota_limited',
                     'network_error'
                   )
               ) as unhealthy_reachable_provider_count,
               greatest(
                 coalesce(
                   (
                     select max(
                       (
                         budget_periods.cost_used_usd / nullif(agent_limits.limit_value, 0)
                       )::double precision
                     )
                     from agent_limits
                     join budget_periods
                       on budget_periods.agent_id = agent_limits.agent_id
                      and budget_periods.period_type = agent_limits.period
                     where agent_limits.agent_id = agents.id
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
                     from agent_limits
                     join rate_limit_windows
                       on rate_limit_windows.agent_id = agent_limits.agent_id
                      and rate_limit_windows.limit_type = agent_limits.limit_type
                     where agent_limits.agent_id = agents.id
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
                     from agent_limits
                     join rate_limit_windows
                       on rate_limit_windows.agent_id = agent_limits.agent_id
                      and rate_limit_windows.limit_type = agent_limits.limit_type
                     where agent_limits.agent_id = agents.id
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
        where agents.deleted_at is null
        order by agents.name
      `,
    );
    return result.rows.map(rowToConsoleAgent);
  });
}

export function normalizeAgentVirtualModelAccessInput(
  input: AgentVirtualModelAccessInput,
): NormalizedAgentVirtualModelAccessInput {
  const id = normalizeRequiredText(input.id, "Agent id");
  const allowedVirtualModelIds = Array.from(
    new Set(normalizeTextList(input.allowedVirtualModelIds)),
  );
  const defaultVirtualModelId = normalizeOptionalText(input.defaultVirtualModelId);

  assertDefaultVirtualModelIsAllowed({ allowedVirtualModelIds, defaultVirtualModelId });

  return {
    allowedVirtualModelIds,
    defaultVirtualModelId,
    id,
  };
}

export function normalizeAgentVirtualModelAccessFormInput(
  input: AgentVirtualModelAccessInput,
): NormalizedAgentVirtualModelAccessInput {
  const defaultVirtualModelId = normalizeOptionalText(input.defaultVirtualModelId);
  const allowedVirtualModelIds = normalizeTextList(input.allowedVirtualModelIds);

  return normalizeAgentVirtualModelAccessInput({
    ...input,
    allowedVirtualModelIds:
      defaultVirtualModelId && !allowedVirtualModelIds.includes(defaultVirtualModelId)
        ? [...allowedVirtualModelIds, defaultVirtualModelId]
        : allowedVirtualModelIds,
    defaultVirtualModelId,
  });
}

export function formatAgentVirtualModelAccess(input: {
  allowedVirtualModels: AgentVirtualModel[];
  defaultVirtualModel: AgentVirtualModel | null;
}): { allowedLabel: string; defaultLabel: string } {
  return {
    allowedLabel:
      input.allowedVirtualModels.length === 0
        ? "None"
        : input.allowedVirtualModels.map(formatVirtualModelLabel).join(", "),
    defaultLabel: input.defaultVirtualModel
      ? formatVirtualModelLabel(input.defaultVirtualModel)
      : "None",
  };
}

export async function listAgentVirtualModelAccess(
  databaseUrl?: string,
): Promise<AgentVirtualModelAccess[]> {
  return withClient(databaseUrl, async (client) => readAgentVirtualModelAccess(client));
}

export async function updateAgentVirtualModelAccess(input: {
  access: NormalizedAgentVirtualModelAccessInput;
  databaseUrl?: string;
}): Promise<AgentVirtualModelAccess> {
  let savedAccess: AgentVirtualModelAccess | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update Agent virtual model access ${input.access.id}`,
    changes: [
      { table: "agents", recordId: input.access.id },
      { table: "agent_virtual_models", recordId: input.access.id },
    ],
    write: async (client) => {
      assertDefaultVirtualModelIsAllowed(input.access);
      await assertAgentExists(client, input.access.id);
      await assertVirtualModelsAvailable(client, input.access.allowedVirtualModelIds);

      await client.query("delete from agent_virtual_models where agent_id = $1", [input.access.id]);

      for (const virtualModelId of input.access.allowedVirtualModelIds) {
        await client.query(
          `
            insert into agent_virtual_models (agent_id, virtual_model_id)
            values ($1, $2)
          `,
          [input.access.id, virtualModelId],
        );
      }

      await client.query(
        `
          update agents
          set default_virtual_model_id = $2,
              updated_at = now()
          where id = $1
        `,
        [input.access.id, input.access.defaultVirtualModelId],
      );

      savedAccess = requireAgentVirtualModelAccess(
        await readAgentVirtualModelAccessById(client, input.access.id),
      );
    },
  });

  return requireAgentVirtualModelAccess(savedAccess);
}

export async function createAgent(input: {
  agent: NormalizedAgentFormInput;
  databaseUrl?: string;
}): Promise<ConsoleAgentCreateResult> {
  const agentId = randomUUID();
  const plaintext = generateAgentApiKeyPlaintext();
  const stored = prepareAgentApiKeyForStorage(plaintext);
  let agent: ConsoleAgentCreateResult | undefined;

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
            key_prefix,
            key_hash,
            enabled
          )
          values ($1, $2, $3, $4, $5, $6, $7, true)
          returning id::text,
                    name,
                    agent_type,
                    integration_platform,
                    request_logging_enabled,
                    key_prefix,
                    enabled,
                    created_at,
                    updated_at,
                    true as has_api_key,
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
          stored.keyPrefix,
          stored.keyHash,
        ],
      );
      agent = { ...rowToConsoleAgent(requireRow(result.rows[0])), plaintext };
    },
  });

  return requireSavedAgent(agent);
}

export async function updateAgent(input: {
  agent: NormalizedAgentFormInput;
  databaseUrl?: string;
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
            and deleted_at is null
          returning id::text,
                    name,
                    agent_type,
                    integration_platform,
                    request_logging_enabled,
                    key_prefix,
                    enabled,
                    created_at,
                    updated_at,
                    (key_hash is not null) as has_api_key,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.agent_id = agents.id
                    ) as request_attribution_count,
                    (
                      select max(request_activity.started_at)
                      from request_activity
                      where request_activity.agent_id = agents.id
                    ) as latest_request_at,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.agent_id = agents.id
                        and request_activity.started_at >= now() - interval '1 hour'
                    ) as recent_request_count,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.agent_id = agents.id
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

export async function deleteAgent(input: { databaseUrl?: string; id: string }): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete agent ${input.id}`,
    changes: [{ table: "agents", recordId: input.id }],
    write: async (client) => {
      await assertAgentExists(client, input.id);

      const result = await client.query<{ id: string }>(
        `
          update agents
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
        throw new Error("Agent was not deleted.");
      }
    },
  });
}

async function assertAgentExists(client: AgentQueryClient, agentId: string): Promise<void> {
  const result = await client.query(
    "select 1 from agents where id = $1 and deleted_at is null for update",
    [agentId],
  );
  if (!result.rows[0]) {
    throw new Error("Agent was not found.");
  }
}

async function assertVirtualModelsAvailable(
  client: AgentQueryClient,
  virtualModelIds: readonly string[],
): Promise<void> {
  if (virtualModelIds.length === 0) {
    return;
  }

  const result = await client.query<{ id: string }>(
    `
      select id::text
      from virtual_models
      where enabled = true
        and deleted_at is null
        and id = any($1::uuid[])
    `,
    [virtualModelIds],
  );
  const availableIds = new Set(result.rows.map((row) => row.id));
  const missingId = virtualModelIds.find((id) => !availableIds.has(id));
  if (missingId) {
    throw new Error(`Allowed Virtual Model was not found or is disabled: ${missingId}`);
  }
}

async function readAgentVirtualModelAccessById(
  client: AgentQueryClient,
  agentId: string,
): Promise<AgentVirtualModelAccess | undefined> {
  return (await readAgentVirtualModelAccess(client, agentId))[0];
}

async function readAgentVirtualModelAccess(
  client: AgentQueryClient,
  agentId?: string,
): Promise<AgentVirtualModelAccess[]> {
  const baseResult = await client.query<AgentVirtualModelAccessBaseRow>(
    `
      select agents.id::text as agent_id,
             default_virtual_models.id::text as default_virtual_model_id,
             default_virtual_models.name as default_virtual_model_name,
             default_virtual_models.description as default_virtual_model_display_name
      from agents
      left join virtual_models default_virtual_models
        on default_virtual_models.id = agents.default_virtual_model_id
       and default_virtual_models.deleted_at is null
      where agents.deleted_at is null
        and ($1::uuid is null or agents.id = $1::uuid)
      order by agents.created_at
    `,
    [agentId ?? null],
  );
  const allowedResult = await client.query<AgentAllowedVirtualModelRow>(
    `
      select agent_virtual_models.agent_id::text as agent_id,
             virtual_models.id::text,
             virtual_models.name,
             virtual_models.description as display_name
      from agent_virtual_models
      join virtual_models on virtual_models.id = agent_virtual_models.virtual_model_id
      join agents on agents.id = agent_virtual_models.agent_id
      where agents.deleted_at is null
        and virtual_models.deleted_at is null
        and ($1::uuid is null or agent_virtual_models.agent_id = $1::uuid)
      order by virtual_models.name
    `,
    [agentId ?? null],
  );
  const allowedByAgentId = new Map<string, AgentVirtualModel[]>();
  for (const row of allowedResult.rows) {
    const values = allowedByAgentId.get(row.agent_id) ?? [];
    values.push({
      displayName: row.display_name,
      id: row.id,
      name: row.name,
    });
    allowedByAgentId.set(row.agent_id, values);
  }

  return baseResult.rows.map((row) => ({
    agentId: row.agent_id,
    allowedVirtualModels: allowedByAgentId.get(row.agent_id) ?? [],
    defaultVirtualModel:
      row.default_virtual_model_id &&
      row.default_virtual_model_name &&
      row.default_virtual_model_display_name
        ? {
            displayName: row.default_virtual_model_display_name,
            id: row.default_virtual_model_id,
            name: row.default_virtual_model_name,
          }
        : null,
  }));
}

function rowToConsoleAgent(row: AgentRow): ConsoleAgent {
  const limitUsageRatio = readNumber(row.limit_usage_ratio);

  return {
    agentType: row.agent_type,
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    hasApiKey: row.has_api_key,
    id: row.id,
    integrationPlatform: row.integration_platform,
    keyPrefix: row.key_prefix,
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
    updatedAt: new Date(row.updated_at),
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

function normalizeAgentApiKeyPlaintext(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw new Error("Agent API key plaintext is required.");
  }
  if (plaintext.length <= agentApiKeyPrefixLength) {
    throw new Error("Agent API key must be longer than the stored prefix.");
  }
  return plaintext;
}

function assertDefaultVirtualModelIsAllowed(input: {
  allowedVirtualModelIds: readonly string[];
  defaultVirtualModelId: string | null;
}): void {
  if (
    input.defaultVirtualModelId &&
    !input.allowedVirtualModelIds.includes(input.defaultVirtualModelId)
  ) {
    throw new Error("Default Virtual Model must be included in the allowed Virtual Models.");
  }
}

function formatVirtualModelLabel(virtualModel: AgentVirtualModel): string {
  return `${virtualModel.displayName} (${virtualModel.name})`;
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeTextList(
  values: readonly (string | null | undefined)[] | string | null | undefined,
): string[] {
  const rawValues = Array.isArray(values) ? values : values ? [values] : [];
  return rawValues.flatMap((value) => {
    const normalized = normalizeOptionalText(value);
    return normalized ? [normalized] : [];
  });
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

function requireSavedAgent<T extends ConsoleAgent>(agent: T | undefined): T {
  if (!agent) {
    throw new Error("Agent was not saved.");
  }
  return agent;
}

function requireAgentVirtualModelAccess(
  access: AgentVirtualModelAccess | undefined,
): AgentVirtualModelAccess {
  if (!access) {
    throw new Error("Agent virtual model access was not saved.");
  }
  return access;
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
