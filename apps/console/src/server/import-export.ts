import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";
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
  providerType: "api_key" | "local";
};

export type ExportedProviderModel = {
  availability: "available" | "deprecated" | "not_listed" | "unavailable";
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
  strategy: "balanced" | "cost_first" | "fixed" | "quality_first";
  virtualModelId: string;
};

export type ExportedAgent = {
  agentApiKeys: ExportedAgentApiKey[];
  agentType: "coding" | "desktop" | "ide" | "other" | "terminal";
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
  enabled: boolean;
  limitType: "budget" | "rpm" | "token" | "tpm";
  limitValue: number;
  period: "day" | "hour" | "minute" | "month" | "request" | "week";
  unit: "requests" | "tokens" | "usd";
};

export type ConfigImportResult = {
  importedAgentApiKeyCount: number;
  importedAgentCount: number;
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

type ProviderRow = QueryResultRow & {
  base_url: string | null;
  display_name: string;
  enabled: boolean;
  id: string;
  provider_key: string;
  provider_template_id: string | null;
  provider_type: "api_key" | "local";
};

type ProviderModelRow = QueryResultRow & {
  availability: ExportedProviderModel["availability"];
  context_window: number | null;
  display_name: string;
  id: string;
  model_id: string;
  provider_id: string;
  supports_streaming: boolean;
  supports_tools: boolean;
};

type ProviderApiKeyRow = QueryResultRow & {
  key_prefix: string;
  provider_id: string;
};

type VirtualModelRow = QueryResultRow & {
  display_name: string;
  enabled: boolean;
  id: string;
  name: string;
};

type RoutePolicyRow = QueryResultRow & {
  id: string;
  strategy: ExportedRoutePolicy["strategy"];
  virtual_model_id: string;
};

type RoutePolicyCandidateRow = QueryResultRow & {
  candidate_order: number;
  is_fallback: boolean;
  provider_model_id: string;
  route_policy_id: string;
};

type AgentRow = QueryResultRow & {
  agent_type: ExportedAgent["agentType"];
  enabled: boolean;
  id: string;
  name: string;
};

type AgentApiKeyRow = QueryResultRow & {
  agent_id: string;
  default_virtual_model_id: string | null;
  enabled: boolean;
  id: string;
  key_prefix: string;
};

type AgentApiKeyVirtualModelRow = QueryResultRow & {
  agent_api_key_id: string;
  virtual_model_id: string;
};

type AgentLimitRow = QueryResultRow & {
  agent_api_key_id: string;
  enabled: boolean;
  limit_type: ExportedAgentLimit["limitType"];
  limit_value: string;
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
      { table: "agent_api_keys" },
      { table: "agent_limits" },
    ],
    write: async (client) => {
      await writeProviders(client, document.providers);
      await writeProviderModels(client, document.providers);
      await writeVirtualModels(client, document.virtualModels);
      await writeAgents(client, document.agents);
      await writeAgentApiKeys(client, document.agents);
      await writeAgentApiKeyAccess(client, document.agents);
      await writeAgentLimits(client, document.agents);
      await writeRoutePolicies(client, document.routePolicies);
      await writeRoutePolicyCandidates(client, document.routePolicies);
    },
  });

  return {
    importedAgentApiKeyCount: document.agents.reduce(
      (count, agent) => count + agent.agentApiKeys.length,
      0,
    ),
    importedAgentCount: document.agents.length,
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
             availability
      from provider_models
      order by provider_id, model_id
    `,
  );
  const grouped = new Map<string, ExportedProviderModel[]>();
  for (const row of result.rows) {
    const models = grouped.get(row.provider_id) ?? [];
    models.push({
      availability: row.availability,
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
      select provider_id::text,
             key_prefix
      from provider_api_keys
      order by provider_id, created_at, id
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
             display_name,
             enabled
      from virtual_models
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
      select id::text,
             virtual_model_id::text,
             strategy
      from route_policies
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
      strategy: policy.strategy,
      virtualModelId: policy.virtual_model_id,
    };
  });
}

async function readAgents(client: QueryClient): Promise<ExportedAgent[]> {
  const agents = await client.query<AgentRow>(
    `
        select id::text,
               name,
               agent_type,
               enabled
        from agents
        order by name
      `,
  );
  const agentApiKeys = await client.query<AgentApiKeyRow>(
    `
        select id::text,
               agent_id::text,
               key_prefix,
               default_virtual_model_id::text,
               enabled
        from agent_api_keys
        order by agent_id, created_at, id
      `,
  );
  const access = await client.query<AgentApiKeyVirtualModelRow>(
    `
        select agent_api_key_id::text,
               virtual_model_id::text
        from agent_api_key_virtual_models
        order by agent_api_key_id, virtual_model_id
      `,
  );
  const limits = await client.query<AgentLimitRow>(
    `
        select agent_api_key_id::text,
               limit_type,
               period,
               limit_value::text,
               unit,
               enabled
        from agent_limits
        order by agent_api_key_id, limit_type, period
      `,
  );
  const accessByKeyId = groupRows(access.rows, (row) => row.agent_api_key_id);
  const limitsByKeyId = groupRows(limits.rows, (row) => row.agent_api_key_id);
  const apiKeysByAgentId = groupRows(agentApiKeys.rows, (row) => row.agent_id);

  return agents.rows.map((agent) => ({
    agentApiKeys: (apiKeysByAgentId.get(agent.id) ?? []).map((apiKey) => ({
      allowedVirtualModelIds: (accessByKeyId.get(apiKey.id) ?? []).map(
        (row) => row.virtual_model_id,
      ),
      defaultVirtualModelId: apiKey.default_virtual_model_id,
      enabled: apiKey.enabled,
      id: apiKey.id,
      keyPrefix: apiKey.key_prefix,
      limits: (limitsByKeyId.get(apiKey.id) ?? []).map((limit) => ({
        enabled: limit.enabled,
        limitType: limit.limit_type,
        limitValue: Number(limit.limit_value),
        period: limit.period,
        unit: limit.unit,
      })),
      secret: "redacted",
    })),
    agentType: agent.agent_type,
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
          id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (id) do update
        set provider_type = excluded.provider_type,
            provider_key = excluded.provider_key,
            provider_template_id = excluded.provider_template_id,
            display_name = excluded.display_name,
            base_url = excluded.base_url,
            enabled = excluded.enabled,
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
            supports_tools, availability
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict (id) do update
          set provider_id = excluded.provider_id,
              model_id = excluded.model_id,
              display_name = excluded.display_name,
              context_window = excluded.context_window,
              supports_streaming = excluded.supports_streaming,
              supports_tools = excluded.supports_tools,
              availability = excluded.availability,
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
        insert into virtual_models (id, name, display_name, enabled)
        values ($1, $2, $3, $4)
        on conflict (id) do update
        set name = excluded.name,
            display_name = excluded.display_name,
            enabled = excluded.enabled,
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
        insert into agents (id, name, agent_type, enabled)
        values ($1, $2, $3, $4)
        on conflict (id) do update
        set name = excluded.name,
            agent_type = excluded.agent_type,
            enabled = excluded.enabled,
            updated_at = now()
      `,
      [agent.id, agent.name, agent.agentType, agent.enabled],
    );
  }
}

async function writeAgentApiKeys(
  client: QueryClient,
  agents: readonly ExportedAgent[],
): Promise<void> {
  for (const agent of agents) {
    for (const apiKey of agent.agentApiKeys) {
      await client.query(
        `
          insert into agent_api_keys (
            id, agent_id, key_prefix, key_hash, default_virtual_model_id, enabled
          )
          values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do update
          set agent_id = excluded.agent_id,
              key_prefix = excluded.key_prefix,
              default_virtual_model_id = excluded.default_virtual_model_id,
              enabled = excluded.enabled,
              updated_at = now()
        `,
        [
          apiKey.id,
          agent.id,
          apiKey.keyPrefix,
          buildRedactedImportAgentKeyHash(apiKey.id),
          apiKey.defaultVirtualModelId,
          apiKey.enabled,
        ],
      );
    }
  }
}

async function writeAgentApiKeyAccess(
  client: QueryClient,
  agents: readonly ExportedAgent[],
): Promise<void> {
  const apiKeyIds = agents.flatMap((agent) => agent.agentApiKeys.map((apiKey) => apiKey.id));
  if (apiKeyIds.length === 0) {
    return;
  }

  await client.query(
    "delete from agent_api_key_virtual_models where agent_api_key_id = any($1::uuid[])",
    [apiKeyIds],
  );
  for (const agent of agents) {
    for (const apiKey of agent.agentApiKeys) {
      for (const virtualModelId of apiKey.allowedVirtualModelIds) {
        await client.query(
          `
            insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id)
            values ($1, $2)
          `,
          [apiKey.id, virtualModelId],
        );
      }
    }
  }
}

async function writeAgentLimits(
  client: QueryClient,
  agents: readonly ExportedAgent[],
): Promise<void> {
  const apiKeyIds = agents.flatMap((agent) => agent.agentApiKeys.map((apiKey) => apiKey.id));
  if (apiKeyIds.length === 0) {
    return;
  }

  await client.query("delete from agent_limits where agent_api_key_id = any($1::uuid[])", [
    apiKeyIds,
  ]);
  for (const agent of agents) {
    for (const apiKey of agent.agentApiKeys) {
      for (const limit of apiKey.limits) {
        await client.query(
          `
            insert into agent_limits (
              id, agent_api_key_id, limit_type, period, limit_value, unit, enabled
            )
            values ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            randomUUID(),
            apiKey.id,
            limit.limitType,
            limit.period,
            limit.limitValue,
            limit.unit,
            limit.enabled,
          ],
        );
      }
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
        insert into route_policies (id, virtual_model_id, strategy)
        values ($1, $2, $3)
        on conflict (id) do update
        set virtual_model_id = excluded.virtual_model_id,
            strategy = excluded.strategy,
            updated_at = now()
      `,
      [routePolicy.id, routePolicy.virtualModelId, routePolicy.strategy],
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
      strategy: normalizeEnum(
        input.strategy,
        ["balanced", "cost_first", "fixed", "quality_first"],
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
      agentApiKeys: normalizeAgentApiKeys(input.agentApiKeys, `agents[${index}].agentApiKeys`),
      agentType: normalizeEnum(
        input.agentType,
        ["coding", "desktop", "ide", "other", "terminal"],
        `agents[${index}].agentType`,
      ),
      enabled: normalizeBoolean(input.enabled, `agents[${index}].enabled`),
      id: normalizeUuid(input.id, `agents[${index}].id`),
      name: normalizeText(input.name, `agents[${index}].name`),
    };
  });
}

function normalizeAgentApiKeys(value: unknown, path: string): ExportedAgentApiKey[] {
  return normalizeArray(value, path).map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    if (input.secret !== "redacted") {
      throw new Error(`${path}[${index}].secret must be redacted.`);
    }
    return {
      allowedVirtualModelIds: normalizeUuidArray(
        input.allowedVirtualModelIds,
        `${path}[${index}].allowedVirtualModelIds`,
      ),
      defaultVirtualModelId: normalizeNullableUuid(
        input.defaultVirtualModelId,
        `${path}[${index}].defaultVirtualModelId`,
      ),
      enabled: normalizeBoolean(input.enabled, `${path}[${index}].enabled`),
      id: normalizeUuid(input.id, `${path}[${index}].id`),
      keyPrefix: normalizeText(input.keyPrefix, `${path}[${index}].keyPrefix`),
      limits: normalizeAgentLimits(input.limits, `${path}[${index}].limits`),
      secret: "redacted",
    };
  });
}

function normalizeAgentLimits(value: unknown, path: string): ExportedAgentLimit[] {
  return normalizeArray(value, path).map((input, index) => {
    if (!isRecord(input)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    return {
      enabled: normalizeBoolean(input.enabled, `${path}[${index}].enabled`),
      limitType: normalizeEnum(
        input.limitType,
        ["budget", "rpm", "token", "tpm"],
        `${path}[${index}].limitType`,
      ),
      limitValue: normalizePositiveNumber(input.limitValue, `${path}[${index}].limitValue`),
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
    document.agents.flatMap((agent) => agent.agentApiKeys.map((apiKey) => apiKey.id)),
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
    document.agents.flatMap((agent) => agent.agentApiKeys.map((apiKey) => apiKey.keyPrefix)),
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
    for (const apiKey of agent.agentApiKeys) {
      if (apiKey.defaultVirtualModelId && !virtualModelIds.has(apiKey.defaultVirtualModelId)) {
        throw new Error("Agent API key default Virtual Model was not found.");
      }
      if (
        apiKey.defaultVirtualModelId &&
        !apiKey.allowedVirtualModelIds.includes(apiKey.defaultVirtualModelId)
      ) {
        throw new Error("Agent API key default Virtual Model must be allowed.");
      }
      for (const virtualModelId of apiKey.allowedVirtualModelIds) {
        if (!virtualModelIds.has(virtualModelId)) {
          throw new Error("Agent API key allowed Virtual Model was not found.");
        }
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
  if (template.baseUrlMode === "user_local_private" && !isLocalOrPrivateUrl(provider.baseUrl)) {
    throw new Error("Imported local provider base URL must be local or private.");
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

function buildRedactedImportAgentKeyHash(agentApiKeyId: string): string {
  return `redacted-import:v1:${agentApiKeyId}`;
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
  const client = new Client({ connectionString: databaseUrl });
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

function isLocalOrPrivateUrl(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local")) {
    return true;
  }
  if (
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.")
  ) {
    return true;
  }
  const match = /^172\.(\d{1,2})\./.exec(hostname);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}
