import { randomUUID } from "node:crypto";
import type { ManualPriceOverride, SyncedPriceSnapshot } from "@llmingress/billing/price-registry";
import { resolveEffectiveModelTokenPrice } from "@llmingress/billing/price-registry";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type AgentLimitType = "budget" | "rpm" | "token" | "tpm";
export type AgentLimitPeriod = "day" | "hour" | "minute" | "month" | "request" | "week";
export type AgentLimitUnit = "requests" | "tokens" | "usd";

export type AgentLimitRuleInput = {
  limitType: AgentLimitType;
  limitValue: number;
  period: AgentLimitPeriod;
  unit: AgentLimitUnit;
};

export type AgentLimitFormInput = {
  agentApiKeyId?: string | null;
  budgetPeriod?: string | null;
  budgetUsd?: string | number | null;
  rpm?: string | number | null;
  tokenLimit?: string | number | null;
  tpm?: string | number | null;
};

export type NormalizedAgentLimitFormInput = {
  agentApiKeyId: string;
  rules: AgentLimitRuleInput[];
};

export type ConsoleAgentLimit = AgentLimitRuleInput & {
  agentApiKeyId: string;
  enabled: boolean;
  id: string;
};

type AgentLimitRow = QueryResultRow & {
  agent_api_key_id: string;
  enabled: boolean;
  id: string;
  limit_type: AgentLimitType;
  limit_value: string;
  period: AgentLimitPeriod;
  unit: AgentLimitUnit;
};

type AccessibleRouteCandidatePriceRow = QueryResultRow & {
  candidate_order: number;
  is_fallback: boolean;
  model_display_name: string;
  model_id: string;
  price_override_input_usd_per_million_tokens: string | null;
  price_override_output_usd_per_million_tokens: string | null;
  price_override_updated_at: Date | null;
  price_sync_cached_input_usd_per_million_tokens: string | null;
  price_sync_input_usd_per_million_tokens: string | null;
  price_sync_output_usd_per_million_tokens: string | null;
  price_sync_price_version: string | null;
  price_sync_source_url: string | null;
  price_sync_synced_at: Date | null;
  provider_display_name: string;
  provider_key: string;
  virtual_model_display_name: string;
  virtual_model_name: string;
};

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

const budgetPeriods = ["day", "week", "month"] as const;

export const defaultAgentLimitFormValues = {
  budgetPeriod: "month",
  budgetUsd: 10,
  rpm: 60,
  tokenLimit: 200_000,
  tpm: 1_000_000,
} as const;

export function normalizeAgentLimitFormInput(
  input: AgentLimitFormInput,
): NormalizedAgentLimitFormInput {
  const agentApiKeyId = normalizeRequiredText(input.agentApiKeyId, "Agent API key id");
  const budgetPeriod = normalizeBudgetPeriod(input.budgetPeriod);

  return {
    agentApiKeyId,
    rules: [
      {
        limitType: "budget",
        limitValue: normalizePositiveNumber(input.budgetUsd, "Budget USD limit"),
        period: budgetPeriod,
        unit: "usd",
      },
      {
        limitType: "rpm",
        limitValue: normalizePositiveNumber(input.rpm, "RPM limit"),
        period: "minute",
        unit: "requests",
      },
      {
        limitType: "tpm",
        limitValue: normalizePositiveNumber(input.tpm, "TPM limit"),
        period: "minute",
        unit: "tokens",
      },
      {
        limitType: "token",
        limitValue: normalizePositiveNumber(input.tokenLimit, "Token limit"),
        period: "request",
        unit: "tokens",
      },
    ],
  };
}

export function formatAgentLimitSummaries(
  limits: readonly ConsoleAgentLimit[],
): Record<AgentLimitType, string> {
  return {
    budget: formatLimitSummary(limits.find((limit) => limit.limitType === "budget")),
    rpm: formatLimitSummary(limits.find((limit) => limit.limitType === "rpm")),
    token: formatLimitSummary(limits.find((limit) => limit.limitType === "token")),
    tpm: formatLimitSummary(limits.find((limit) => limit.limitType === "tpm")),
  };
}

export async function listAgentLimits(databaseUrl: string): Promise<ConsoleAgentLimit[]> {
  return withClient(databaseUrl, (client) => readAgentLimits(client));
}

export async function saveAgentLimitRules(input: {
  databaseUrl: string;
  limits: NormalizedAgentLimitFormInput;
}): Promise<ConsoleAgentLimit[]> {
  let savedLimits: ConsoleAgentLimit[] | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update Agent API key limits ${input.limits.agentApiKeyId}`,
    changes: [{ table: "agent_limits", recordId: input.limits.agentApiKeyId }],
    write: async (client) => {
      await assertAgentApiKeyExists(client, input.limits.agentApiKeyId);
      if (input.limits.rules.some((rule) => rule.limitType === "budget" && rule.unit === "usd")) {
        await assertAccessibleRouteCandidatePricesKnown(client, input.limits.agentApiKeyId);
      }

      await client.query(
        `
          delete from agent_limits
          where agent_api_key_id = $1
            and limit_type = any($2::text[])
        `,
        [input.limits.agentApiKeyId, input.limits.rules.map((rule) => rule.limitType)],
      );

      for (const rule of input.limits.rules) {
        await client.query(
          `
            insert into agent_limits (
              id,
              agent_api_key_id,
              limit_type,
              period,
              limit_value,
              unit,
              enabled
            )
            values ($1, $2, $3, $4, $5, $6, true)
          `,
          [
            randomUUID(),
            input.limits.agentApiKeyId,
            rule.limitType,
            rule.period,
            rule.limitValue,
            rule.unit,
          ],
        );
      }

      savedLimits = await readAgentLimits(client, input.limits.agentApiKeyId);
    },
  });

  if (!savedLimits) {
    throw new Error("Agent API key limits were not saved.");
  }
  return savedLimits;
}

async function assertAgentApiKeyExists(client: QueryClient, id: string): Promise<void> {
  const result = await client.query("select 1 from agent_api_keys where id = $1 for update", [id]);
  if (!result.rows[0]) {
    throw new Error("Agent API key was not found.");
  }
}

async function assertAccessibleRouteCandidatePricesKnown(
  client: QueryClient,
  agentApiKeyId: string,
): Promise<void> {
  const candidates = await readAccessibleRouteCandidatePrices(client, agentApiKeyId);
  const missingPriceCandidates = candidates.filter((candidate) => {
    const price = resolveEffectiveModelTokenPrice({
      manualOverride: rowToManualPriceOverride(candidate),
      modelId: candidate.model_id,
      providerKey: candidate.provider_key,
      syncedPrice: rowToSyncedPriceSnapshot(candidate),
    });
    return price.status === "unknown_price";
  });

  if (missingPriceCandidates.length === 0) {
    return;
  }

  const candidateLabels = missingPriceCandidates
    .map((candidate) => {
      const routeRole = candidate.is_fallback ? "fallback" : "primary";
      return `${candidate.virtual_model_display_name} (${candidate.virtual_model_name}) ${routeRole} candidate ${candidate.provider_display_name} - ${candidate.model_display_name} (${candidate.model_id})`;
    })
    .join("; ");
  throw new Error(
    `Cannot enable cost budget because the Agent API key can reach route candidates with unknown price: ${candidateLabels}. Save a manual price override, sync prices, or choose priced replacements before enabling the budget.`,
  );
}

async function readAccessibleRouteCandidatePrices(
  client: QueryClient,
  agentApiKeyId: string,
): Promise<AccessibleRouteCandidatePriceRow[]> {
  const result = await client.query<AccessibleRouteCandidatePriceRow>(
    `
      with accessible_virtual_models as (
        select distinct virtual_models.id,
               virtual_models.name,
               virtual_models.display_name
        from agent_api_keys
        join virtual_models
          on virtual_models.enabled = true
         and (
              agent_api_keys.default_virtual_model_id = virtual_models.id
              or exists (
                select 1
                from agent_api_key_virtual_models
                where agent_api_key_virtual_models.agent_api_key_id = agent_api_keys.id
                  and agent_api_key_virtual_models.virtual_model_id = virtual_models.id
              )
         )
        where agent_api_keys.id = $1
      )
      select accessible_virtual_models.name as virtual_model_name,
             accessible_virtual_models.display_name as virtual_model_display_name,
             route_policy_candidates.candidate_order,
             route_policy_candidates.is_fallback,
             providers.provider_key,
             providers.display_name as provider_display_name,
             provider_models.model_id,
             provider_models.display_name as model_display_name,
             model_price_overrides.input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
             model_price_overrides.output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
             model_price_overrides.updated_at as price_override_updated_at,
             latest_price_registry_snapshot.input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
             latest_price_registry_snapshot.cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
             latest_price_registry_snapshot.output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
             latest_price_registry_snapshot.price_version as price_sync_price_version,
             latest_price_registry_snapshot.source_url as price_sync_source_url,
             latest_price_registry_snapshot.snapshot_at as price_sync_synced_at
      from accessible_virtual_models
      join route_policies on route_policies.virtual_model_id = accessible_virtual_models.id
      join route_policy_candidates on route_policy_candidates.route_policy_id = route_policies.id
      join provider_models on provider_models.id = route_policy_candidates.provider_model_id
      join providers on providers.id = provider_models.provider_id
      left join model_price_overrides
        on lower(model_price_overrides.provider_key) = lower(providers.provider_key)
       and model_price_overrides.model_id = provider_models.model_id
      left join lateral (
        select input_usd_per_million_tokens,
               cached_input_usd_per_million_tokens,
               output_usd_per_million_tokens,
               price_version,
               source_url,
               snapshot_at
        from price_registry_snapshots
        where lower(price_registry_snapshots.provider_key) = lower(providers.provider_key)
          and price_registry_snapshots.model_id = provider_models.model_id
        order by snapshot_at desc, created_at desc
        limit 1
      ) latest_price_registry_snapshot on true
      where providers.enabled = true
        and provider_models.availability = 'available'
      order by accessible_virtual_models.name,
               route_policy_candidates.is_fallback,
               route_policy_candidates.candidate_order,
               providers.provider_key,
               provider_models.model_id
    `,
    [agentApiKeyId],
  );
  return result.rows;
}

function rowToManualPriceOverride(
  row: AccessibleRouteCandidatePriceRow,
): ManualPriceOverride | null {
  if (
    row.price_override_input_usd_per_million_tokens === null ||
    row.price_override_output_usd_per_million_tokens === null ||
    row.price_override_updated_at === null
  ) {
    return null;
  }

  return {
    inputUsdPerMillionTokens: Number(row.price_override_input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.price_override_output_usd_per_million_tokens),
    providerKey: row.provider_key,
    updatedAt: row.price_override_updated_at,
  };
}

function rowToSyncedPriceSnapshot(
  row: AccessibleRouteCandidatePriceRow,
): SyncedPriceSnapshot | null {
  if (
    row.price_sync_input_usd_per_million_tokens === null ||
    row.price_sync_output_usd_per_million_tokens === null ||
    row.price_sync_price_version === null ||
    row.price_sync_synced_at === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      row.price_sync_cached_input_usd_per_million_tokens === null
        ? null
        : Number(row.price_sync_cached_input_usd_per_million_tokens),
    inputUsdPerMillionTokens: Number(row.price_sync_input_usd_per_million_tokens),
    modelId: row.model_id,
    outputUsdPerMillionTokens: Number(row.price_sync_output_usd_per_million_tokens),
    priceVersion: row.price_sync_price_version,
    providerKey: row.provider_key,
    sourceUrl: row.price_sync_source_url,
    syncedAt: row.price_sync_synced_at,
  };
}

async function readAgentLimits(
  client: QueryClient,
  agentApiKeyId?: string,
): Promise<ConsoleAgentLimit[]> {
  const result = await client.query<AgentLimitRow>(
    `
      select id::text,
             agent_api_key_id::text,
             limit_type,
             period,
             limit_value::text,
             unit,
             enabled
      from agent_limits
      where ($1::uuid is null or agent_api_key_id = $1::uuid)
      order by agent_api_key_id, limit_type
    `,
    [agentApiKeyId ?? null],
  );
  return result.rows.map((row) => ({
    agentApiKeyId: row.agent_api_key_id,
    enabled: row.enabled,
    id: row.id,
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    period: row.period,
    unit: row.unit,
  }));
}

function formatLimitSummary(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  if (limit.unit === "usd") {
    return `$${limit.limitValue.toFixed(2)} / ${limit.period}`;
  }
  return `${formatNumber(limit.limitValue)} ${limit.unit} / ${limit.period}`;
}

function normalizeBudgetPeriod(value: string | null | undefined): (typeof budgetPeriods)[number] {
  const period = normalizeRequiredText(value, "Budget period");
  if (!budgetPeriods.includes(period as (typeof budgetPeriods)[number])) {
    throw new Error("Budget period must be day, week, or month.");
  }
  return period as (typeof budgetPeriods)[number];
}

function normalizePositiveNumber(value: string | number | null | undefined, label: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return numberValue;
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
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
