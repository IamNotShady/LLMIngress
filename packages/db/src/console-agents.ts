import { createHash, randomBytes, randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import {
  type AgentLimitRuleInput,
  replaceAgentLimitRulesWithClient,
} from "./console-agent-limits.ts";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

export type AgentIntegrationPlatform =
  | "claude-code"
  | "codex"
  | "cursor"
  | "github-copilot"
  | "hermes"
  | "openclaw"
  | "opencode"
  | "other";

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
  integrationPlatform?: string | null;
  name?: string | null;
};

export type NormalizedAgentFormInput = {
  integrationPlatform: AgentIntegrationPlatform;
  name: string;
};

export type ConsoleAgent = NormalizedAgentFormInput & {
  createdAt: Date;
  enabled: boolean;
  hasApiKey: boolean;
  id: string;
  keyPrefix: string | null;
  limitsEnabled: boolean;
  requestAttributionCount: number;
  updatedAt: Date;
};

export type ConsoleAgentCreateResult = ConsoleAgent & {
  plaintext: string;
  virtualModelAccess: AgentVirtualModelAccess;
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

export type AgentVirtualModelSelectionInput = Omit<AgentVirtualModelAccessInput, "id">;

export type NormalizedAgentVirtualModelSelectionInput = {
  allowedVirtualModelIds: string[];
  defaultVirtualModelId: string | null;
};

export type NormalizedAgentVirtualModelAccessInput = NormalizedAgentVirtualModelSelectionInput & {
  id: string;
};

type AgentRow = {
  created_at: Date;
  enabled: boolean;
  has_api_key: boolean;
  id: string;
  integration_platform: AgentIntegrationPlatform;
  key_prefix: string | null;
  limits_enabled: boolean;
  name: string;
  request_attribution_count: number;
  updated_at: Date;
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
  const integrationPlatform = (input.integrationPlatform ?? "other").trim().toLowerCase();

  if (!name) {
    throw consoleValidationError("Agent name is required.", "agent_name_required", {
      field: "name",
    });
  }
  if (!isAgentIntegrationPlatform(integrationPlatform)) {
    throw consoleValidationError(
      "Agent integration platform must be codex, claude-code, cursor, opencode, hermes, openclaw, github-copilot, or other.",
      "agent_integration_platform_invalid",
      { field: "integrationPlatform" },
    );
  }

  return {
    integrationPlatform,
    name,
  };
}

export async function listAgents(databaseUrl?: string): Promise<ConsoleAgent[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<AgentRow>(
      `
        select agents.id::text,
               agents.name,
               agents.integration_platform,
               agents.key_prefix,
               agents.enabled,
               agents.limits_enabled,
               agents.created_at,
               agents.updated_at,
               (agents.key_hash is not null) as has_api_key,
               (
                 select count(*)::integer
                 from request_activity
                 where request_activity.agent_id = agents.id
               ) as request_attribution_count
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
  return {
    ...normalizeAgentVirtualModelSelectionInput(input),
    id,
  };
}

export function normalizeAgentVirtualModelSelectionInput(
  input: AgentVirtualModelSelectionInput,
): NormalizedAgentVirtualModelSelectionInput {
  const allowedVirtualModelIds = Array.from(
    new Set(normalizeTextList(input.allowedVirtualModelIds)),
  );
  const defaultVirtualModelId = normalizeOptionalText(input.defaultVirtualModelId);

  if (allowedVirtualModelIds.length === 0) {
    throw consoleValidationError(
      "Select at least one allowed Virtual Model.",
      "agent_allowed_virtual_model_required",
      { field: "allowedVirtualModelIds" },
    );
  }
  assertDefaultVirtualModelIsAllowed({ allowedVirtualModelIds, defaultVirtualModelId });

  return {
    allowedVirtualModelIds,
    defaultVirtualModelId,
  };
}

export function normalizeAgentVirtualModelAccessFormInput(
  input: AgentVirtualModelAccessInput,
): NormalizedAgentVirtualModelAccessInput {
  return normalizeAgentVirtualModelAccessInput(input);
}

export async function listAgentVirtualModelAccess(
  databaseUrl?: string,
): Promise<AgentVirtualModelAccess[]> {
  return withPooledPostgresClient(databaseUrl, async (client) =>
    readAgentVirtualModelAccess(client),
  );
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

      await replaceAgentVirtualModelsWithClient(client, input.access.id, input.access);

      savedAccess = requireAgentVirtualModelAccess(
        await readAgentVirtualModelAccessById(client, input.access.id),
      );
    },
  });

  return requireAgentVirtualModelAccess(savedAccess);
}

export async function createAgentWithSettings(input: {
  agent: NormalizedAgentFormInput;
  databaseUrl?: string;
  limitRules: readonly AgentLimitRuleInput[];
  limitsEnabled: boolean;
  virtualModels: NormalizedAgentVirtualModelSelectionInput;
}): Promise<ConsoleAgentCreateResult> {
  const agentId = randomUUID();
  const plaintext = generateAgentApiKeyPlaintext();
  const stored = prepareAgentApiKeyForStorage(plaintext);
  let agent: ConsoleAgentCreateResult | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Create agent ${input.agent.name}`,
    changes: [
      { table: "agents", recordId: agentId },
      { table: "agent_virtual_models", recordId: agentId },
      { table: "agent_limits", recordId: agentId },
    ],
    write: async (client) => {
      await assertVirtualModelsAvailable(client, input.virtualModels.allowedVirtualModelIds);
      const result = await client.query<AgentRow>(
        `
          insert into agents (
            id,
            name,
            integration_platform,
            key_prefix,
            key_hash,
            enabled,
            limits_enabled
          )
          values ($1, $2, $3, $4, $5, true, $6)
          returning id::text,
                    name,
                    integration_platform,
                    key_prefix,
                    enabled,
                    limits_enabled,
                    created_at,
                    updated_at,
                    true as has_api_key,
                    0::integer as request_attribution_count
        `,
        [
          agentId,
          input.agent.name,
          input.agent.integrationPlatform,
          stored.keyPrefix,
          stored.keyHash,
          input.limitsEnabled,
        ],
      );
      await replaceAgentVirtualModelsWithClient(client, agentId, input.virtualModels);
      if (input.limitsEnabled) {
        await replaceAgentLimitRulesWithClient(client, agentId, input.limitRules);
      }
      agent = {
        ...rowToConsoleAgent(requireRow(result.rows[0])),
        plaintext,
        virtualModelAccess: requireAgentVirtualModelAccess(
          await readAgentVirtualModelAccessById(client, agentId),
        ),
      };
    },
  });

  return requireSavedAgent(agent);
}

export async function updateAgentWithSettings(input: {
  agent: NormalizedAgentFormInput;
  databaseUrl?: string;
  id: string;
  limitRules: readonly AgentLimitRuleInput[];
  limitsEnabled: boolean;
  virtualModels: NormalizedAgentVirtualModelSelectionInput;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update Agent settings ${input.id}`,
    changes: [
      { table: "agents", recordId: input.id },
      { table: "agent_virtual_models", recordId: input.id },
      { table: "agent_limits", recordId: input.id },
    ],
    write: async (client) => {
      await assertAgentExists(client, input.id);
      await assertVirtualModelsAvailable(client, input.virtualModels.allowedVirtualModelIds);
      await client.query(
        `
          update agents
          set name = $2,
              integration_platform = $3,
              limits_enabled = $4,
              updated_at = now()
          where id = $1
            and deleted_at is null
        `,
        [input.id, input.agent.name, input.agent.integrationPlatform, input.limitsEnabled],
      );
      await replaceAgentVirtualModelsWithClient(client, input.id, input.virtualModels);
      if (input.limitsEnabled) {
        await replaceAgentLimitRulesWithClient(client, input.id, input.limitRules);
      }
    },
  });
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
              integration_platform = $3,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text,
                    name,
                    integration_platform,
                    key_prefix,
                    enabled,
                    limits_enabled,
                    created_at,
                    updated_at,
                    (key_hash is not null) as has_api_key,
                    (
                      select count(*)::integer
                      from request_activity
                      where request_activity.agent_id = agents.id
                    ) as request_attribution_count
        `,
        [input.id, input.agent.name, input.agent.integrationPlatform],
      );
      agent = rowToConsoleAgent(requireRow(result.rows[0]));
    },
  });

  return requireSavedAgent(agent);
}

export async function setAgentEnabled(input: {
  databaseUrl?: string;
  enabled: boolean;
  id: string;
}): Promise<void> {
  await updateAgentBooleanSetting({
    databaseUrl: input.databaseUrl,
    description: `${input.enabled ? "Enable" : "Disable"} Agent ${input.id}`,
    id: input.id,
    setClause: "enabled = $2",
    value: input.enabled,
  });
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
    throw consoleNotFoundError("Agent was not found.", "agent_not_found", { agentId });
  }
}

async function replaceAgentVirtualModelsWithClient(
  client: AgentQueryClient,
  agentId: string,
  virtualModels: NormalizedAgentVirtualModelSelectionInput,
): Promise<void> {
  await client.query("delete from agent_virtual_models where agent_id = $1", [agentId]);
  for (const virtualModelId of virtualModels.allowedVirtualModelIds) {
    await client.query(
      `insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)`,
      [agentId, virtualModelId],
    );
  }
  await client.query(
    `update agents set default_virtual_model_id = $2, updated_at = now() where id = $1`,
    [agentId, virtualModels.defaultVirtualModelId],
  );
}

async function updateAgentBooleanSetting(input: {
  databaseUrl?: string;
  description: string;
  id: string;
  setClause: "enabled = $2";
  value: boolean;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: input.description,
    changes: [{ table: "agents", recordId: input.id }],
    write: async (client) => {
      await assertAgentExists(client, input.id);
      await client.query(
        `update agents set ${input.setClause}, updated_at = now() where id = $1 and deleted_at is null`,
        [input.id, input.value],
      );
    },
  });
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
    throw consoleValidationError(
      `Allowed Virtual Model was not found or is disabled: ${missingId}`,
      "agent_virtual_model_not_available",
      { virtualModelId: missingId },
    );
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
  return {
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    hasApiKey: row.has_api_key,
    id: row.id,
    integrationPlatform: row.integration_platform,
    keyPrefix: row.key_prefix,
    limitsEnabled: row.limits_enabled,
    name: row.name,
    requestAttributionCount: row.request_attribution_count,
    updatedAt: new Date(row.updated_at),
  };
}

function isAgentIntegrationPlatform(value: string): value is AgentIntegrationPlatform {
  return agentIntegrationPlatforms.includes(value as AgentIntegrationPlatform);
}

function normalizeAgentApiKeyPlaintext(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw consoleValidationError("Agent API key plaintext is required.", "agent_api_key_required");
  }
  if (plaintext.length <= agentApiKeyPrefixLength) {
    throw consoleValidationError(
      "Agent API key must be longer than the stored prefix.",
      "agent_api_key_too_short",
    );
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
    throw consoleValidationError(
      "Default Virtual Model must be included in the allowed Virtual Models.",
      "agent_default_virtual_model_not_allowed",
      { defaultVirtualModelId: input.defaultVirtualModelId },
    );
  }
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw consoleValidationError(`${label} is required.`, "form_field_required", { field: label });
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

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw consoleNotFoundError("Agent was not found.", "agent_not_found");
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
