import { randomUUID } from "node:crypto";
import type { ManualPriceOverride, SyncedPriceSnapshot } from "@llmingress/billing/price-registry";
import { resolveEffectiveModelTokenPrice } from "@llmingress/billing/price-registry";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type AgentLimitType = "budget" | "concurrency" | "rpm" | "token" | "tpm";
export type AgentLimitEnforcementPolicy = "block" | "warn_only";
export type AgentLimitPeriod = "day" | "hour" | "minute" | "month" | "request" | "week";
export type AgentLimitUnit = "requests" | "tokens" | "usd";

export type AgentLimitRuleInput = {
  alertThreshold?: number | null;
  enforcementPolicy?: AgentLimitEnforcementPolicy;
  limitType: AgentLimitType;
  limitValue: number;
  manualBypass?: boolean;
  period: AgentLimitPeriod;
  unit: AgentLimitUnit;
};

export type AgentLimitFormInput = {
  agentId?: string | null;
  budgetPeriod?: string | null;
  budgetUsd?: string | number | null;
  rpm?: string | number | null;
  tokenLimit?: string | number | null;
  tpm?: string | number | null;
};

export type NormalizedAgentLimitFormInput = {
  agentId: string;
  rules: AgentLimitRuleInput[];
};

export type ConsoleAgentLimit = AgentLimitRuleInput & {
  agentId: string;
  enabled: boolean;
  id: string;
};

type AgentLimitRow = QueryResultRow & {
  alert_threshold: string | null;
  agent_id: string;
  enabled: boolean;
  enforcement_policy: AgentLimitEnforcementPolicy;
  id: string;
  limit_type: AgentLimitType;
  limit_value: string;
  manual_bypass: boolean;
  period: AgentLimitPeriod;
  unit: AgentLimitUnit;
};

type AccessibleRouteCandidatePriceRow = QueryResultRow & {
  candidate_order: number;
  is_fallback: boolean;
  model_display_name: string;
  model_id: string;
  price_override_cached_input_usd_per_million_tokens: string | null;
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
  const agentId = normalizeRequiredText(input.agentId, "Agent id");
  const budgetPeriod = normalizeBudgetPeriod(input.budgetPeriod);

  return {
    agentId,
    rules: [
      {
        alertThreshold: null,
        enforcementPolicy: "block",
        limitType: "budget",
        limitValue: normalizePositiveNumber(input.budgetUsd, "Budget USD limit"),
        manualBypass: false,
        period: budgetPeriod,
        unit: "usd",
      },
      {
        alertThreshold: null,
        enforcementPolicy: "block",
        limitType: "rpm",
        limitValue: normalizePositiveNumber(input.rpm, "RPM limit"),
        manualBypass: false,
        period: "minute",
        unit: "requests",
      },
      {
        alertThreshold: null,
        enforcementPolicy: "block",
        limitType: "tpm",
        limitValue: normalizePositiveNumber(input.tpm, "TPM limit"),
        manualBypass: false,
        period: "minute",
        unit: "tokens",
      },
      {
        alertThreshold: null,
        enforcementPolicy: "block",
        limitType: "token",
        limitValue: normalizePositiveNumber(input.tokenLimit, "Token limit"),
        manualBypass: false,
        period: "request",
        unit: "tokens",
      },
    ],
  };
}

export function formatAgentLimitSummaries(
  limits: readonly ConsoleAgentLimit[],
): Record<Exclude<AgentLimitType, "concurrency">, string> {
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
    description: `Update Agent limits ${input.limits.agentId}`,
    changes: [{ table: "agent_limits", recordId: input.limits.agentId }],
    write: async (client) => {
      await assertAgentExists(client, input.limits.agentId);
      if (input.limits.rules.some((rule) => rule.limitType === "budget" && rule.unit === "usd")) {
        await assertAccessibleRouteCandidatePricesKnown(client, input.limits.agentId);
      }

      await client.query(
        `
          delete from agent_limits
          where agent_id = $1
            and limit_type = any($2::text[])
        `,
        [input.limits.agentId, input.limits.rules.map((rule) => rule.limitType)],
      );

      for (const rule of input.limits.rules) {
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
            values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)
          `,
          [
            randomUUID(),
            input.limits.agentId,
            rule.limitType,
            rule.period,
            rule.limitValue,
            rule.unit,
            rule.alertThreshold ?? null,
            rule.enforcementPolicy ?? "block",
            rule.manualBypass ?? false,
          ],
        );
      }

      savedLimits = await readAgentLimits(client, input.limits.agentId);
    },
  });

  if (!savedLimits) {
    throw new Error("Agent limits were not saved.");
  }
  return savedLimits;
}

async function assertAgentExists(client: QueryClient, id: string): Promise<void> {
  const result = await client.query("select 1 from agents where id = $1 for update", [id]);
  if (!result.rows[0]) {
    throw new Error("Agent was not found.");
  }
}

async function assertAccessibleRouteCandidatePricesKnown(
  client: QueryClient,
  agentId: string,
): Promise<void> {
  const candidates = await readAccessibleRouteCandidatePrices(client, agentId);
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
    `Cannot enable cost budget because the Agent can reach route candidates with unknown price: ${candidateLabels}. Save a manual price override, sync prices, or choose priced replacements before enabling the budget.`,
  );
}

async function readAccessibleRouteCandidatePrices(
  client: QueryClient,
  agentId: string,
): Promise<AccessibleRouteCandidatePriceRow[]> {
  const result = await client.query<AccessibleRouteCandidatePriceRow>(
    `
      with accessible_virtual_models as (
        select distinct virtual_models.id,
               virtual_models.name,
               virtual_models.display_name
        from agents
        join virtual_models
          on virtual_models.enabled = true
         and (
              agents.default_virtual_model_id = virtual_models.id
              or exists (
                select 1
                from agent_virtual_models
                where agent_virtual_models.agent_id = agents.id
                  and agent_virtual_models.virtual_model_id = virtual_models.id
              )
         )
        where agents.id = $1
      )
      select accessible_virtual_models.name as virtual_model_name,
             accessible_virtual_models.display_name as virtual_model_display_name,
             route_policy_candidates.candidate_order,
             route_policy_candidates.is_fallback,
             providers.provider_key,
             providers.display_name as provider_display_name,
             provider_models.model_id,
             provider_models.display_name as model_display_name,
             provider_models.manual_input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
             provider_models.manual_cached_input_usd_per_million_tokens::text as price_override_cached_input_usd_per_million_tokens,
             provider_models.manual_output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
             provider_models.manual_price_updated_at as price_override_updated_at,
             latest_provider_model_price.input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
             latest_provider_model_price.cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
             latest_provider_model_price.output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
             latest_provider_model_price.price_version as price_sync_price_version,
             latest_provider_model_price.source_url as price_sync_source_url,
             latest_provider_model_price.synced_at as price_sync_synced_at
      from accessible_virtual_models
      join route_policies on route_policies.virtual_model_id = accessible_virtual_models.id
      join route_policy_candidates on route_policy_candidates.route_policy_id = route_policies.id
      join provider_models on provider_models.id = route_policy_candidates.provider_model_id
      join providers on providers.id = provider_models.provider_id
      left join lateral (
        select input_usd_per_million_tokens,
               cached_input_usd_per_million_tokens,
               output_usd_per_million_tokens,
               price_version,
               source_url,
               synced_at
        from provider_models_price
        where lower(provider_models_price.provider_key) = lower(providers.provider_key)
          and provider_models_price.model_id = provider_models.model_id
        order by case provider_models_price.source
                   when 'models.dev' then 0
                   when 'litellm' then 1
                   else 2
                 end,
                 synced_at desc,
                 updated_at desc
        limit 1
      ) latest_provider_model_price on true
      where providers.enabled = true
        and provider_models.availability = 'available'
      order by accessible_virtual_models.name,
               route_policy_candidates.is_fallback,
               route_policy_candidates.candidate_order,
               providers.provider_key,
               provider_models.model_id
    `,
    [agentId],
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
    cachedInputUsdPerMillionTokens:
      row.price_override_cached_input_usd_per_million_tokens === null
        ? null
        : Number(row.price_override_cached_input_usd_per_million_tokens),
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
  agentId?: string,
): Promise<ConsoleAgentLimit[]> {
  const result = await client.query<AgentLimitRow>(
    `
      select id::text,
             agent_id::text as agent_id,
             limit_type,
             period,
             limit_value::text,
             unit,
             enabled,
             alert_threshold::text,
             enforcement_policy,
             manual_bypass
      from agent_limits
      where ($1::uuid is null or agent_id = $1::uuid)
      order by agent_id, limit_type
    `,
    [agentId ?? null],
  );
  return result.rows.map((row) => ({
    alertThreshold: row.alert_threshold === null ? null : Number(row.alert_threshold),
    agentId: row.agent_id,
    enabled: row.enabled,
    enforcementPolicy: row.enforcement_policy,
    id: row.id,
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    manualBypass: row.manual_bypass,
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
