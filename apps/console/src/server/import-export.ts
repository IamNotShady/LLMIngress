import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/maintenance";
import {
  normalizeProviderModelCapabilities,
  normalizeRoutePolicyRules,
  type ProviderModelCapabilities,
  type RoutePolicyRules,
} from "@llmingress/domain";
import { listProviderTemplateSelectorGroups } from "./provider-templates";

export type LlmIngressConfigExport = {
  agents: ExportedAgent[];
  exportedAt: string;
  kind: "llmingress.config.export";
  providers: ExportedProvider[];
  routePolicies: ExportedRoutePolicy[];
  version: 1;
  virtualModels: ExportedVirtualModel[];
};

export type ExportedProvider = {
  baseUrl: string | null;
  displayName: string;
  enabled: boolean;
  id: string;
  models: ExportedProviderModel[];
  providerApiKeys: ExportedProviderApiKey[];
  providerKey: string;
  providerTemplateId: string | null;
  providerType: "api_key" | "local" | "subscription";
};

export type ExportedProviderModel = {
  availability: "available" | "deprecated" | "not_listed" | "unavailable";
  capabilityMetadata: ProviderModelCapabilities;
  contextWindow: number | null;
  displayName: string;
  id: string;
  modelId: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
};

export type ExportedProviderApiKey = {
  keyPrefix: string;
  secret: "redacted";
};

export type ExportedVirtualModel = {
  displayName: string;
  enabled: boolean;
  id: string;
  name: string;
};

export type ExportedRoutePolicy = {
  fallbackProviderModelIds: string[];
  id: string;
  primaryProviderModelIds: string[];
  rules: RoutePolicyRules;
  strategy: "cost_first" | "fixed" | "quality_first" | "random";
  virtualModelId: string;
};

export type ExportedAgent = {
  agentType: "coding" | "desktop" | "ide" | "other" | "terminal";
  apiKey: ExportedAgentApiKey | null;
  enabled: boolean;
  id: string;
  name: string;
};

export type ExportedAgentApiKey = {
  allowedVirtualModelIds: string[];
  defaultVirtualModelId: string | null;
  enabled: boolean;
  id: string;
  keyPrefix: string;
  limits: ExportedAgentLimit[];
  secret: "redacted";
};

export type ExportedAgentLimit = {
  alertThreshold: number | null;
  enabled: boolean;
  enforcementPolicy: "block" | "warn_only";
  limitType: "budget" | "concurrency" | "rpm" | "token" | "tpm";
  limitValue: number;
  manualBypass: boolean;
  period: "day" | "hour" | "minute" | "month" | "request" | "week";
  unit: "requests" | "tokens" | "usd";
};

export type ConfigImportResult = {
  importedAgentCount: number;
  importedAgentKeyCount: number;
  importedProviderCount: number;
  importedProviderModelCount: number;
  importedRoutePolicyCount: number;
  importedVirtualModelCount: number;
  version: number;
};

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

type ProviderRow = PostgresQueryResultRow & {
  base_url: string | null;
  display_name: string;
  enabled: boolean;
  id: string;
  provider_key: string;
  provider_template_id: string | null;
  provider_type: "api_key" | "local";
};

type ProviderModelRow = PostgresQueryResultRow & {
  availability: ExportedProviderModel["availability"];
  capability_metadata: unknown;
  context_window: number | null;
  display_name: string;
  id: string;
  model_id: string;
  provider_id: string;
  supports_streaming: boolean;
  supports_tools: boolean;
};

type ProviderApiKeyRow = PostgresQueryResultRow & {
  key_prefix: string;
  provider_id: string;
};

type VirtualModelRow = PostgresQueryResultRow & {
  display_name: string;
  enabled: boolean;
  id: string;
  name: string;
};

type RoutePolicyRow = PostgresQueryResultRow & {
  id: string;
  rules: unknown;
  strategy: ExportedRoutePolicy["strategy"];
  virtual_model_id: string;
};

type RoutePolicyCandidateRow = PostgresQueryResultRow & {
  candidate_order: number;
  is_fallback: boolean;
  provider_model_id: string;
  route_policy_id: string;
};

type AgentRow = PostgresQueryResultRow & {
  agent_type: ExportedAgent["agentType"];
  default_virtual_model_id: string | null;
  enabled: boolean;
  id: string;
  key_prefix: string | null;
  name: string;
};

type AgentVirtualModelRow = PostgresQueryResultRow & {
  agent_id: string;
  virtual_model_id: string;
};

type AgentLimitRow = PostgresQueryResultRow & {
  alert_threshold: string | null;
  agent_id: string;
  enabled: boolean;
  enforcement_policy: ExportedAgentLimit["enforcementPolicy"];
  limit_type: ExportedAgentLimit["limitType"];
  limit_value: string;
  manual_bypass: boolean;
  period: ExportedAgentLimit["period"];
  unit: ExportedAgentLimit["unit"];
};

const fixedUntemplatedProviderBaseUrls = new Map([
  ["anthropic", "https://api.anthropic.com/v1"],
  ["openai", "https://api.openai.com/v1"],
]);

export async function exportConsoleConfig(input: {
  databaseUrl: string;
  now?: Date;
}): Promise<LlmIngressConfigExport> {
  return withClient(input.databaseUrl, async (client) => {
    const providers = await readProviders(client);
    const providerModels = await readProviderModels(client);
    const providerApiKeys = await readProviderApiKeys(client);
    const virtualModels = await readVirtualModels(client);
    const routePolicies = await readRoutePolicies(client);
    const agents = await readAgents(client);

    return {
      agents,
      exportedAt: (input.now ?? new Date()).toISOString(),
      kind: "llmingress.config.export",
      providers: providers.map((provider) => ({
        ...provider,
        models: providerModels.get(provider.id) ?? [],
        providerApiKeys: providerApiKeys.get(provider.id) ?? [],
      })),
      routePolicies,
      version: 1,
      virtualModels,
    };
  });
}

export async function importConsoleConfig(input: {
  databaseUrl: string;
  document: unknown;
}): Promise<ConfigImportResult> {
  const document = normalizeConfigDocument(input.document);
  validateConfigDocument(document);

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  const result = await publisher.publish({
    source: "console",
    description: "Import redacted configuration",
    changes: [
      { table: "providers" },
      { table: "provider_models" },
      { table: "virtual_models" },
      { table: "route_policies" },
      { table: "agents" },
      { table: "agents" },
      { table: "agent_limits" },
    ],
    write: async (client) => {
      await writeProviders(client, document.providers);
      await writeProviderModels(client, document.providers);
      await writeVirtualModels(client, document.virtualModels);
      await writeAgents(client, document.agents);
      await writeAgentAccess(client, document.agents);
      await writeAgentLimits(client, document.agents);
      await writeRoutePolicies(client, document.routePolicies);
      await writeRoutePolicyCandidates(client, document.routePolicies);
    },
  });

  return {
    importedAgentCount: document.agents.length,
    importedAgentKeyCount: document.agents.filter((agent) => agent.apiKey).length,
    importedProviderCount: document.providers.length,
    importedProviderModelCount: document.providers.reduce(
      (count, provider) => count + provider.models.length,
      0,
    ),
    importedRoutePolicyCount: document.routePolicies.length,
    importedVirtualModelCount: document.virtualModels.length,
    version: result.version,
  };
}

async function readProviders(client: QueryClient): Promise<Omit<ExportedProvider, "models">[]> {
  const result = await client.query<ProviderRow>(
    `
      select id::text,
             provider_type,
             provider_key,
             provider_template_id,
             display_name,
             base_url,
             enabled
      from providers
      where deleted_at is null
      order by provider_key
    `,
  );
  return result.rows.map((row) => ({
    baseUrl: row.base_url,
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    providerApiKeys: [],
    providerKey: row.provider_key,
    providerTemplateId: row.provider_template_id,
    providerType: row.provider_type,
  }));
}

async function readProviderModels(
  client: QueryClient,
): Promise<Map<string, ExportedProviderModel[]>> {
  const result = await client.query<ProviderModelRow>(
    `
      select id::text,
             provider_id::text,
             model_id,
             display_name,
             context_window,
             supports_streaming,
             supports_tools,
             capability_metadata,
             availability
      from provider_models
      where deleted_at is null
      order by provider_id, model_id
    `,
  );
  const grouped = new Map<string, ExportedProviderModel[]>();
  for (const row of result.rows) {
    const models = grouped.get(row.provider_id) ?? [];
    models.push({
      availability: row.availability,
      capabilityMetadata: normalizeProviderModelCapabilities(row.capability_metadata),
      contextWindow: row.context_window,
      displayName: row.display_name,
      id: row.id,
      modelId: row.model_id,
      supportsStreaming: row.supports_streaming,
      supportsTools: row.supports_tools,
    });
    grouped.set(row.provider_id, models);
  }
  return grouped;
}

async function readProviderApiKeys(
  client: QueryClient,
): Promise<Map<string, ExportedProviderApiKey[]>> {
  const result = await client.query<ProviderApiKeyRow>(
    `
      select provider_api_keys.provider_id::text,
             provider_api_keys.key_prefix
      from provider_api_keys
      join providers on providers.id = provider_api_keys.provider_id
      where providers.deleted_at is null
      order by provider_api_keys.provider_id,
               provider_api_keys.created_at,
               provider_api_keys.id
    `,
  );
  const grouped = new Map<string, ExportedProviderApiKey[]>();
  for (const row of result.rows) {
    const apiKeys = grouped.get(row.provider_id) ?? [];
    apiKeys.push({
      keyPrefix: row.key_prefix,
      secret: "redacted",
    });
    grouped.set(row.provider_id, apiKeys);
  }
  return grouped;
}

async function readVirtualModels(client: QueryClient): Promise<ExportedVirtualModel[]> {
  const result = await client.query<VirtualModelRow>(
    `
      select id::text,
             name,
             description as display_name,
             enabled
      from virtual_models
      where deleted_at is null
      order by name
    `,
  );
  return result.rows.map((row) => ({
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    name: row.name,
  }));
}

async function readRoutePolicies(client: QueryClient): Promise<ExportedRoutePolicy[]> {
  const policies = await client.query<RoutePolicyRow>(
    `
      select route_policies.id::text,
             route_policies.virtual_model_id::text,
             route_policies.rules,
             route_policies.strategy
      from route_policies
      join virtual_models on virtual_models.id = route_policies.virtual_model_id
      where route_policies.deleted_at is null
        and virtual_models.deleted_at is null
      order by id
    `,
  );
  const candidates = await client.query<RoutePolicyCandidateRow>(
    `
      select route_policy_id::text,
             provider_model_id::text,
             candidate_order,
             is_fallback
      from route_policy_candidates
      join route_policies on route_policies.id = route_policy_candidates.route_policy_id
      join provider_models on provider_models.id = route_policy_candidates.provider_model_id
      join providers on providers.id = provider_models.provider_id
      where route_policies.deleted_at is null
        and provider_models.deleted_at is null
        and providers.deleted_at is null
      order by route_policy_id, candidate_order
    `,
  );
  const candidatesByPolicyId = new Map<string, RoutePolicyCandidateRow[]>();
  for (const candidate of candidates.rows) {
    const policyCandidates = candidatesByPolicyId.get(candidate.route_policy_id) ?? [];
    policyCandidates.push(candidate);
    candidatesByPolicyId.set(candidate.route_policy_id, policyCandidates);
  }

  return policies.rows.map((policy) => {
    const policyCandidates = candidatesByPolicyId.get(policy.id) ?? [];
    return {
      fallbackProviderModelIds: policyCandidates
        .filter((candidate) => candidate.is_fallback)
        .map((candidate) => candidate.provider_model_id),
      id: policy.id,
      primaryProviderModelIds: policyCandidates
        .filter((candidate) => !candidate.is_fallback)
        .map((candidate) => candidate.provider_model_id),
      rules: normalizeRoutePolicyRules(policy.rules),
      strategy: policy.strategy,
      virtualModelId: policy.virtual_model_id,
    };
  });
}

async function readAgents(client: QueryClient): Promise<ExportedAgent[]> {
  const agents = await client.query<AgentRow>(
    `
        select agents.id::text,
               agents.name,
               agents.agent_type,
               agents.key_prefix,
               agents.default_virtual_model_id::text,
               agents.enabled
        from agents
        where deleted_at is null
        order by name
      `,
  );
  const access = await client.query<AgentVirtualModelRow>(
    `
        select agent_virtual_models.agent_id::text as agent_id,
               agent_virtual_models.virtual_model_id::text
        from agent_virtual_models
        join agents on agents.id = agent_virtual_models.agent_id
        join virtual_models on virtual_models.id = agent_virtual_models.virtual_model_id
        where agents.deleted_at is null
          and virtual_models.deleted_at is null
        order by agent_virtual_models.agent_id,
                 agent_virtual_models.virtual_model_id
      `,
  );
  const limits = await client.query<AgentLimitRow>(
    `
        select agent_limits.agent_id::text as agent_id,
               agent_limits.limit_type,
               agent_limits.period,
               agent_limits.limit_value::text,
               agent_limits.unit,
               agent_limits.enabled,
               agent_limits.alert_threshold::text,
               agent_limits.enforcement_policy,
               agent_limits.manual_bypass
        from agent_limits
        join agents on agents.id = agent_limits.agent_id
        where agents.deleted_at is null
        order by agent_limits.agent_id,
                 agent_limits.limit_type,
                 agent_limits.period
      `,
  );
  const accessByAgentId = groupRows(access.rows, (row) => row.agent_id);
  const limitsByAgentId = groupRows(limits.rows, (row) => row.agent_id);

  return agents.rows.map((agent) => ({
    agentType: agent.agent_type,
    apiKey: agent.key_prefix
      ? {
          allowedVirtualModelIds: (accessByAgentId.get(agent.id) ?? []).map(
            (row) => row.virtual_model_id,
          ),
          defaultVirtualModelId: agent.default_virtual_model_id,
          enabled: agent.enabled,
          id: agent.id,
          keyPrefix: agent.key_prefix,
          limits: (limitsByAgentId.get(agent.id) ?? []).map((limit) => ({
            alertThreshold: limit.alert_threshold === null ? null : Number(limit.alert_threshold),
            enabled: limit.enabled,
            enforcementPolicy: limit.enforcement_policy,
            limitType: limit.limit_type,
            limitValue: Number(limit.limit_value),
            manualBypass: limit.manual_bypass,
            period: limit.period,
            unit: limit.unit,
          })),
          secret: "redacted",
        }
      : null,
    enabled: agent.enabled,
    id: agent.id,
    name: agent.name,
  }));
}

async function writeProviders(
  client: QueryClient,
  providers: readonly ExportedProvider[],
): Promise<void> {
  for (const provider of providers) {
    await client.query(
      `
        insert into providers (
          id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled,
          deleted_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, null)
        on conflict (id) do update
        set provider_type = excluded.provider_type,
            provider_key = excluded.provider_key,
            provider_template_id = excluded.provider_template_id,
            display_name = excluded.display_name,
            base_url = excluded.base_url,
            enabled = excluded.enabled,
            deleted_at = null,
            updated_at = now()
      `,
      [
        provider.id,
        provider.providerType,
        provider.providerKey,
        provider.providerTemplateId,
        provider.displayName,
        provider.baseUrl,
        provider.enabled,
      ],
    );
  }
}

async function writeProviderModels(
  client: QueryClient,
  providers: readonly ExportedProvider[],
): Promise<void> {
  for (const provider of providers) {
    for (const model of provider.models) {
      await client.query(
        `
          insert into provider_models (
            id, provider_id, model_id, display_name, context_window, supports_streaming,
            supports_tools, availability, capability_metadata, deleted_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, null)
          on conflict (id) do update
          set provider_id = excluded.provider_id,
              model_id = excluded.model_id,
              display_name = excluded.display_name,
              context_window = excluded.context_window,
              supports_streaming = excluded.supports_streaming,
              supports_tools = excluded.supports_tools,
              availability = excluded.availability,
              capability_metadata = excluded.capability_metadata,
              deleted_at = null,
              updated_at = now()
        `,
        [
          model.id,
          provider.id,
          model.modelId,
          model.displayName,
          model.contextWindow,
          model.supportsStreaming,
          model.supportsTools,
          model.availability,
          JSON.stringify(model.capabilityMetadata),
        ],
      );
    }
  }
}

async function writeVirtualModels(
  client: QueryClient,
  virtualModels: readonly ExportedVirtualModel[],
): Promise<void> {
  for (const virtualModel of virtualModels) {
    await client.query(
      `
        insert into virtual_models (id, name, description, enabled, deleted_at)
        values ($1, $2, $3, $4, null)
        on conflict (id) do update
        set name = excluded.name,
            description = excluded.description,
            enabled = excluded.enabled,
            deleted_at = null,
            updated_at = now()
      `,
      [virtualModel.id, virtualModel.name, virtualModel.displayName, virtualModel.enabled],
    );
  }
}

async function writeAgents(client: QueryClient, agents: readonly ExportedAgent[]): Promise<void> {
  for (const agent of agents) {
    await client.query(
      `
        insert into agents (
          id, name, agent_type, key_prefix, key_hash, default_virtual_model_id, enabled, deleted_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, null)
        on conflict (id) do update
        set name = excluded.name,
            agent_type = excluded.agent_type,
            key_prefix = coalesce(agents.key_prefix, excluded.key_prefix),
            key_hash = coalesce(agents.key_hash, excluded.key_hash),
            default_virtual_model_id = excluded.default_virtual_model_id,
            enabled = excluded.enabled,
            deleted_at = null,
            updated_at = now()
      `,
      [
        agent.id,
        agent.name,
        agent.agentType,
        agent.apiKey?.keyPrefix ?? null,
        agent.apiKey ? buildRedactedImportAgentKeyHash(agent.id) : null,
        agent.apiKey?.defaultVirtualModelId ?? null,
        agent.enabled,
      ],
    );
  }
}

async function writeAgentAccess(
  client: QueryClient,
  agents: readonly ExportedAgent[],
): Promise<void> {
  const agentIds = agents.map((agent) => agent.id);
  await client.query("delete from agent_virtual_models where agent_id = any($1::uuid[])", [
    agentIds,
  ]);
  for (const agent of agents) {
    for (const virtualModelId of agent.apiKey?.allowedVirtualModelIds ?? []) {
      await client.query(
        `
          insert into agent_virtual_models (agent_id, virtual_model_id)
          values ($1, $2)
        `,
        [agent.id, virtualModelId],
      );
    }
  }
}

async function writeAgentLimits(
  client: QueryClient,
  agents: readonly ExportedAgent[],
): Promise<void> {
  const agentIds = agents.map((agent) => agent.id);
  await client.query("delete from agent_limits where agent_id = any($1::uuid[])", [agentIds]);
  for (const agent of agents) {
    for (const limit of agent.apiKey?.limits ?? []) {
      await client.query(
        `
          insert into agent_limits (
            id,
            agent_id,
            limit_type,
            period,
            limit_value,
            unit,
            enabled,
            alert_threshold,
            enforcement_policy,
            manual_bypass
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          randomUUID(),
          agent.id,
          limit.limitType,
          limit.period,
          limit.limitValue,
          limit.unit,
          limit.enabled,
          limit.alertThreshold,
          limit.enforcementPolicy,
          limit.manualBypass,
        ],
      );
    }
  }
}

async function writeRoutePolicies(
  client: QueryClient,
  routePolicies: readonly ExportedRoutePolicy[],
): Promise<void> {
  for (const routePolicy of routePolicies) {
    await client.query(
      `
        insert into route_policies (id, virtual_model_id, strategy, rules, deleted_at)
        values ($1, $2, $3, $4::jsonb, null)
        on conflict (id) do update
        set virtual_model_id = excluded.virtual_model_id,
            strategy = excluded.strategy,
            rules = excluded.rules,
            deleted_at = null,
            updated_at = now()
      `,
      [
        routePolicy.id,
        routePolicy.virtualModelId,
        routePolicy.strategy,
        JSON.stringify(routePolicy.rules),
      ],
    );
  }
}

async function writeRoutePolicyCandidates(
  client: QueryClient,
  routePolicies: readonly ExportedRoutePolicy[],
): Promise<void> {
  const routePolicyIds = routePolicies.map((routePolicy) => routePolicy.id);
  if (routePolicyIds.length === 0) {
    return;
  }

  await client.query(
    "delete from route_policy_candidates where route_policy_id = any($1::uuid[])",
    [routePolicyIds],
  );
  for (const routePolicy of routePolicies) {
    let candidateOrder = 1;
    for (const providerModelId of routePolicy.primaryProviderModelIds) {
      await writeRoutePolicyCandidate(client, {
        candidateOrder,
        isFallback: false,
        providerModelId,
        routePolicyId: routePolicy.id,
      });
      candidateOrder += 1;
    }
    for (const providerModelId of routePolicy.fallbackProviderModelIds) {
      await writeRoutePolicyCandidate(client, {
        candidateOrder,
        isFallback: true,
        providerModelId,
        routePolicyId: routePolicy.id,
      });
      candidateOrder += 1;
    }
  }
}

async function writeRoutePolicyCandidate(
  client: QueryClient,
  input: {
    candidateOrder: number;
    isFallback: boolean;
    providerModelId: string;
    routePolicyId: string;
  },
): Promise<void> {
  await client.query(
    `
      insert into route_policy_candidates (
        id, route_policy_id, provider_model_id, candidate_order, is_fallback
      )
      values ($1, $2, $3, $4, $5)
    `,
    [
      randomUUID(),
      input.routePolicyId,
      input.providerModelId,
      input.candidateOrder,
      input.isFallback,
    ],
  );
}

function normalizeConfigDocument(document: unknown): LlmIngressConfigExport {
  if (!isRecord(document)) {
    throw new Error("Config import JSON must be an object.");
  }
  if (document.kind !== "llmingress.config.export" || document.version !== 1) {
    throw new Error("Config import JSON must be a supported LLMIngress config export.");
  }

  return {
    agents: normalizeAgents(document.agents),
    exportedAt: normalizeText(document.exportedAt, "exportedAt"),
    kind: "llmingress.config.export",
    providers: normalizeProviders(document.providers),
    routePolicies: normalizeRoutePolicies(document.routePolicies),
    version: 1,
    virtualModels: normalizeVirtualModels(document.virtualModels),
  };
}

function normalizeProviders(value: unknown): ExportedProvider[] {
  return normalizeArray(value, "providers").map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`providers[${index}] must be an object.`);
    }
    return {
      baseUrl: normalizeNullableText(input.baseUrl, `providers[${index}].baseUrl`),
      displayName: normalizeText(input.displayName, `providers[${index}].displayName`),
      enabled: normalizeBoolean(input.enabled, `providers[${index}].enabled`),
      id: normalizeUuid(input.id, `providers[${index}].id`),
      models: normalizeProviderModels(input.models, `providers[${index}].models`),
      providerApiKeys: normalizeProviderApiKeys(
        input.providerApiKeys,
        `providers[${index}].providerApiKeys`,
      ),
      providerKey: normalizeIdentifier(input.providerKey, `providers[${index}].providerKey`),
      providerTemplateId: normalizeNullableText(
        input.providerTemplateId,
        `providers[${index}].providerTemplateId`,
      ),
      providerType: normalizeEnum(
        input.providerType,
        ["api_key", "local"],
        `providers[${index}].providerType`,
      ),
    };
  });
}

function normalizeProviderModels(value: unknown, path: string): ExportedProviderModel[] {
  return normalizeArray(value, path).map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    return {
      availability: normalizeEnum(
        input.availability,
        ["available", "deprecated", "not_listed", "unavailable"],
        `${path}[${index}].availability`,
      ),
      capabilityMetadata: normalizeProviderModelCapabilities(input.capabilityMetadata ?? {}),
      contextWindow: normalizeNullablePositiveInteger(
        input.contextWindow,
        `${path}[${index}].contextWindow`,
      ),
      displayName: normalizeText(input.displayName, `${path}[${index}].displayName`),
      id: normalizeUuid(input.id, `${path}[${index}].id`),
      modelId: normalizeText(input.modelId, `${path}[${index}].modelId`),
      supportsStreaming: normalizeBoolean(
        input.supportsStreaming,
        `${path}[${index}].supportsStreaming`,
      ),
      supportsTools: normalizeBoolean(input.supportsTools, `${path}[${index}].supportsTools`),
    };
  });
}

function normalizeProviderApiKeys(value: unknown, path: string): ExportedProviderApiKey[] {
  return normalizeArray(value, path).map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    if (input.secret !== "redacted") {
      throw new Error(`${path}[${index}].secret must be redacted.`);
    }
    return {
      keyPrefix: normalizeText(input.keyPrefix, `${path}[${index}].keyPrefix`),
      secret: "redacted",
    };
  });
}

function normalizeVirtualModels(value: unknown): ExportedVirtualModel[] {
  return normalizeArray(value, "virtualModels").map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`virtualModels[${index}] must be an object.`);
    }
    return {
      displayName: normalizeText(input.displayName, `virtualModels[${index}].displayName`),
      enabled: normalizeBoolean(input.enabled, `virtualModels[${index}].enabled`),
      id: normalizeUuid(input.id, `virtualModels[${index}].id`),
      name: normalizeIdentifier(input.name, `virtualModels[${index}].name`),
    };
  });
}

function normalizeRoutePolicies(value: unknown): ExportedRoutePolicy[] {
  return normalizeArray(value, "routePolicies").map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`routePolicies[${index}] must be an object.`);
    }
    return {
      fallbackProviderModelIds: normalizeUuidArray(
        input.fallbackProviderModelIds,
        `routePolicies[${index}].fallbackProviderModelIds`,
      ),
      id: normalizeUuid(input.id, `routePolicies[${index}].id`),
      primaryProviderModelIds: normalizeUuidArray(
        input.primaryProviderModelIds,
        `routePolicies[${index}].primaryProviderModelIds`,
      ),
      rules: normalizeRoutePolicyRules(input.rules ?? {}),
      strategy: normalizeEnum(
        input.strategy,
        ["cost_first", "fixed", "quality_first", "random"],
        `routePolicies[${index}].strategy`,
      ),
      virtualModelId: normalizeUuid(input.virtualModelId, `routePolicies[${index}].virtualModelId`),
    };
  });
}

function normalizeAgents(value: unknown): ExportedAgent[] {
  return normalizeArray(value, "agents").map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`agents[${index}] must be an object.`);
    }
    return {
      agentType: normalizeEnum(
        input.agentType,
        ["coding", "desktop", "ide", "other", "terminal"],
        `agents[${index}].agentType`,
      ),
      apiKey:
        input.apiKey === null || input.apiKey === undefined
          ? null
          : normalizeAgentApiKey(input.apiKey, `agents[${index}].apiKey`),
      enabled: normalizeBoolean(input.enabled, `agents[${index}].enabled`),
      id: normalizeUuid(input.id, `agents[${index}].id`),
      name: normalizeText(input.name, `agents[${index}].name`),
    };
  });
}

function normalizeAgentApiKey(value: unknown, path: string): ExportedAgentApiKey {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  if (value.secret !== "redacted") {
    throw new Error(`${path}.secret must be redacted.`);
  }
  return {
    allowedVirtualModelIds: normalizeUuidArray(
      value.allowedVirtualModelIds,
      `${path}.allowedVirtualModelIds`,
    ),
    defaultVirtualModelId: normalizeNullableUuid(
      value.defaultVirtualModelId,
      `${path}.defaultVirtualModelId`,
    ),
    enabled: normalizeBoolean(value.enabled, `${path}.enabled`),
    id: normalizeUuid(value.id, `${path}.id`),
    keyPrefix: normalizeText(value.keyPrefix, `${path}.keyPrefix`),
    limits: normalizeAgentLimits(value.limits, `${path}.limits`),
    secret: "redacted",
  };
}

function normalizeAgentLimits(value: unknown, path: string): ExportedAgentLimit[] {
  return normalizeArray(value, path).map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    return {
      alertThreshold:
        input.alertThreshold === undefined
          ? null
          : normalizeNullablePositiveNumber(
              input.alertThreshold,
              `${path}[${index}].alertThreshold`,
            ),
      enabled: normalizeBoolean(input.enabled, `${path}[${index}].enabled`),
      enforcementPolicy:
        input.enforcementPolicy === undefined
          ? "block"
          : normalizeEnum(
              input.enforcementPolicy,
              ["block", "warn_only"],
              `${path}[${index}].enforcementPolicy`,
            ),
      limitType: normalizeEnum(
        input.limitType,
        ["budget", "concurrency", "rpm", "token", "tpm"],
        `${path}[${index}].limitType`,
      ),
      limitValue: normalizePositiveNumber(input.limitValue, `${path}[${index}].limitValue`),
      manualBypass:
        input.manualBypass === undefined
          ? false
          : normalizeBoolean(input.manualBypass, `${path}[${index}].manualBypass`),
      period: normalizeEnum(
        input.period,
        ["day", "hour", "minute", "month", "request", "week"],
        `${path}[${index}].period`,
      ),
      unit: normalizeEnum(input.unit, ["requests", "tokens", "usd"], `${path}[${index}].unit`),
    };
  });
}

function validateConfigDocument(document: LlmIngressConfigExport): void {
  const providerTemplateIds = readKnownProviderTemplateIds();
  const providerIds = new Set(document.providers.map((provider) => provider.id));
  const providerModelIds = new Set(
    document.providers.flatMap((provider) => provider.models.map((model) => model.id)),
  );
  const virtualModelIds = new Set(document.virtualModels.map((model) => model.id));
  const agentApiKeyIds = new Set(
    document.agents.flatMap((agent) => (agent.apiKey ? [agent.apiKey.id] : [])),
  );

  assertUnique(
    document.providers.map((provider) => provider.id),
    "Provider ids",
  );
  assertUnique(
    document.providers.map((provider) => provider.providerKey),
    "Provider keys",
  );
  assertUnique([...providerModelIds], "Provider model ids");
  assertUnique(
    document.virtualModels.map((model) => model.id),
    "Virtual Model ids",
  );
  assertUnique(
    document.virtualModels.map((model) => model.name),
    "Virtual Model names",
  );
  assertUnique(
    document.routePolicies.map((policy) => policy.id),
    "Route Policy ids",
  );
  assertUnique(
    document.agents.map((agent) => agent.id),
    "Agent ids",
  );
  assertUnique([...agentApiKeyIds], "Agent API key ids");
  assertUnique(
    document.agents.flatMap((agent) => (agent.apiKey ? [agent.apiKey.keyPrefix] : [])),
    "Agent API key prefixes",
  );

  for (const provider of document.providers) {
    if (provider.providerTemplateId) {
      if (!providerTemplateIds.has(provider.providerTemplateId)) {
        throw new Error("Imported provider must use a whitelisted provider template.");
      }
      validateTemplateProvider(provider, providerTemplateIds);
    } else {
      validateUntemplatedProvider(provider);
    }
    for (const model of provider.models) {
      if (!providerIds.has(provider.id)) {
        throw new Error(`Provider model ${model.id} references an unknown provider.`);
      }
    }
  }

  for (const routePolicy of document.routePolicies) {
    if (!virtualModelIds.has(routePolicy.virtualModelId)) {
      throw new Error("Route Policy references an unknown Virtual Model.");
    }
    if (routePolicy.primaryProviderModelIds.length === 0) {
      throw new Error("Route Policy requires at least one primary provider model.");
    }
    const candidateIds = [
      ...routePolicy.primaryProviderModelIds,
      ...routePolicy.fallbackProviderModelIds,
    ];
    assertUnique(candidateIds, "Route Policy candidate ids");
    for (const candidateId of candidateIds) {
      if (!providerModelIds.has(candidateId)) {
        throw new Error("Route Policy references an unknown Provider Model.");
      }
    }
  }

  for (const agent of document.agents) {
    const apiKey = agent.apiKey;
    if (!apiKey) {
      continue;
    }
    if (apiKey.defaultVirtualModelId && !virtualModelIds.has(apiKey.defaultVirtualModelId)) {
      throw new Error("Agent default Virtual Model was not found.");
    }
    if (
      apiKey.defaultVirtualModelId &&
      !apiKey.allowedVirtualModelIds.includes(apiKey.defaultVirtualModelId)
    ) {
      throw new Error("Agent default Virtual Model must be allowed.");
    }
    for (const virtualModelId of apiKey.allowedVirtualModelIds) {
      if (!virtualModelIds.has(virtualModelId)) {
        throw new Error("Agent allowed Virtual Model was not found.");
      }
    }
  }
}

function validateTemplateProvider(
  provider: ExportedProvider,
  providerTemplateIds: ReadonlySet<string>,
): void {
  if (!provider.providerTemplateId || !providerTemplateIds.has(provider.providerTemplateId)) {
    throw new Error("Imported provider must use a whitelisted provider template.");
  }
  if (provider.providerTemplateId !== provider.providerKey) {
    throw new Error("Imported provider template id must match provider key.");
  }

  const template = readKnownProviderTemplates().get(provider.providerTemplateId);
  if (!template) {
    throw new Error("Imported provider must use a whitelisted provider template.");
  }
  if (provider.providerType !== template.providerType) {
    throw new Error("Imported provider template type does not match provider type.");
  }
  if (
    template.fixedBaseUrl &&
    normalizeUrl(provider.baseUrl) !== normalizeUrl(template.fixedBaseUrl)
  ) {
    throw new Error("Imported provider template base URL does not match the fixed template URL.");
  }
}

function validateUntemplatedProvider(provider: ExportedProvider): void {
  const fixedBaseUrl = fixedUntemplatedProviderBaseUrls.get(provider.providerKey);
  if (!fixedBaseUrl || normalizeUrl(provider.baseUrl) !== normalizeUrl(fixedBaseUrl)) {
    throw new Error("Imported provider must use a whitelisted provider template.");
  }
}

function readKnownProviderTemplateIds(): Set<string> {
  return new Set(readKnownProviderTemplates().keys());
}

function readKnownProviderTemplates() {
  const templates = new Map<
    string,
    {
      baseUrlMode: string;
      fixedBaseUrl?: string;
      providerType: ExportedProvider["providerType"];
    }
  >();
  for (const group of listProviderTemplateSelectorGroups()) {
    for (const template of group.templates) {
      templates.set(template.id, {
        baseUrlMode: template.baseUrlMode,
        fixedBaseUrl: template.fixedBaseUrl,
        providerType: template.providerType,
      });
    }
  }
  return templates;
}

function buildRedactedImportAgentKeyHash(agentId: string): string {
  return `redacted-import:v1:${agentId}`;
}

function groupRows<T>(rows: readonly T[], readKey: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = readKey(row);
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

async function withClient<T>(
  databaseUrl: string,
  operation: (client: QueryClient) => Promise<T>,
): Promise<T> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function normalizeArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function normalizeUuidArray(value: unknown, path: string): string[] {
  return normalizeArray(value, path).map((item, index) => normalizeUuid(item, `${path}[${index}]`));
}

function normalizeText(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeNullableText(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return normalizeText(value, path);
}

function normalizeUuid(value: unknown, path: string): string {
  const text = normalizeText(value, path);
  if (!isUuid(text)) {
    throw new Error(`${path} must be a UUID.`);
  }
  return text;
}

function normalizeNullableUuid(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return normalizeUuid(value, path);
}

function normalizeIdentifier(value: unknown, path: string): string {
  const text = normalizeText(value, path);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(text)) {
    throw new Error(`${path} must use lowercase letters, numbers, dashes, or underscores.`);
  }
  return text;
}

function normalizeBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function normalizeEnum<const T extends readonly string[]>(
  value: unknown,
  allowedValues: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    throw new Error(`${path} is not supported.`);
  }
  return value as T[number];
}

function normalizeNullablePositiveInteger(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer or null.`);
  }
  return value;
}

function normalizeNullablePositiveNumber(value: unknown, path: string): number | null {
  if (value === null) {
    return null;
  }
  return normalizePositiveNumber(value, path);
}

function normalizePositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number.`);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const url = new URL(value);
  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${pathname}`;
}
