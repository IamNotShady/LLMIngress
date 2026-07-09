import { randomUUID } from "node:crypto";
import { resolveEffectiveModelTokenPrice } from "@llmingress/billing/price-registry";
import { PostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { buildManualPriceOverride, buildSyncedPriceSnapshot } from "./price-rows.ts";

export type {
  AgentLimitEnforcementPolicy,
  AgentLimitPeriod,
  AgentLimitType,
  AgentLimitUnit,
} from "@llmingress/domain";

import type {
  AgentLimitEnforcementPolicy,
  AgentLimitPeriod,
  AgentLimitType,
  AgentLimitUnit,
} from "@llmingress/domain";

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
  alertThresholdPercent?: string | number | null;
  budgetPeriod?: string | null;
  budgetUsd?: string | number | null;
  concurrency?: string | number | null;
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

export type ConsoleAgentLimitRuntimeSnapshot = {
  agentId: string;
  budgetUsagePercent: number;
  currentConcurrency: number;
  currentRpm: number;
  currentTpm: number;
  overLimitTodayCount: number;
  overLimitYesterdayCount: number;
  rateLimitHits24h: number;
};

type AgentLimitRow = {
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

type AccessibleRouteCandidatePriceRow = {
  candidate_order: number;
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

type AgentLimitBudgetUsageRow = {
  agent_id: string;
  budget_usage_percent: string | null;
};

type AgentLimitRateWindowRow = {
  agent_id: string;
  current_concurrency: number | null;
  current_rpm: number | null;
  current_tpm: number | null;
};

type AgentLimitErrorCountRow = {
  agent_id: string;
  over_limit_today_count: number;
  over_limit_yesterday_count: number;
  rate_limit_hits_24h: number;
};

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

const budgetPeriods = ["day", "week", "month"] as const;

export const defaultAgentLimitFormValues = {
  alertThresholdPercent: 80,
  budgetPeriod: "month",
  budgetUsd: 10,
  concurrency: 10,
  rpm: 60,
  tokenLimit: 200_000,
  tpm: 1_000_000,
} as const;

export function normalizeAgentLimitFormInput(
  input: AgentLimitFormInput,
): NormalizedAgentLimitFormInput {
  const agentId = normalizeRequiredText(input.agentId, "Agent id");
  const budgetPeriod = normalizeBudgetPeriod(input.budgetPeriod);
  const alertThreshold = normalizeAlertThresholdPercent(input.alertThresholdPercent);

  return {
    agentId,
    rules: [
      {
        alertThreshold,
        enforcementPolicy: "block",
        limitType: "budget",
        limitValue: normalizePositiveNumber(input.budgetUsd, "Budget USD limit"),
        manualBypass: false,
        period: budgetPeriod,
        unit: "usd",
      },
      {
        alertThreshold,
        enforcementPolicy: "block",
        limitType: "rpm",
        limitValue: normalizePositiveNumber(input.rpm, "RPM limit"),
        manualBypass: false,
        period: "minute",
        unit: "requests",
      },
      {
        alertThreshold,
        enforcementPolicy: "block",
        limitType: "tpm",
        limitValue: normalizePositiveNumber(input.tpm, "TPM limit"),
        manualBypass: false,
        period: "minute",
        unit: "tokens",
      },
      {
        alertThreshold,
        enforcementPolicy: "block",
        limitType: "concurrency",
        limitValue: normalizePositiveNumber(
          input.concurrency ?? defaultAgentLimitFormValues.concurrency,
          "Concurrency limit",
        ),
        manualBypass: false,
        period: "request",
        unit: "requests",
      },
      {
        alertThreshold,
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
): Record<AgentLimitType, string> {
  return {
    budget: formatLimitSummary(limits.find((limit) => limit.limitType === "budget")),
    concurrency: formatLimitSummary(limits.find((limit) => limit.limitType === "concurrency")),
    rpm: formatLimitSummary(limits.find((limit) => limit.limitType === "rpm")),
    token: formatLimitSummary(limits.find((limit) => limit.limitType === "token")),
    tpm: formatLimitSummary(limits.find((limit) => limit.limitType === "tpm")),
  };
}

export async function listAgentLimits(databaseUrl?: string): Promise<ConsoleAgentLimit[]> {
  return withClient(databaseUrl, (client) => readAgentLimits(client));
}

export async function listAgentLimitRuntimeSnapshots(
  databaseUrl?: string,
): Promise<ConsoleAgentLimitRuntimeSnapshot[]> {
  return withClient(databaseUrl, async (client) => {
    const budgetUsage = await readAgentLimitBudgetUsage(client);
    const rateWindows = await readAgentLimitRateWindows(client);
    const errorCounts = await readAgentLimitErrorCounts(client);
    const snapshotsByAgentId = new Map<string, ConsoleAgentLimitRuntimeSnapshot>();
    const ensureSnapshot = (agentId: string) => {
      const existing = snapshotsByAgentId.get(agentId);
      if (existing) {
        return existing;
      }
      const snapshot: ConsoleAgentLimitRuntimeSnapshot = {
        agentId,
        budgetUsagePercent: 0,
        currentConcurrency: 0,
        currentRpm: 0,
        currentTpm: 0,
        overLimitTodayCount: 0,
        overLimitYesterdayCount: 0,
        rateLimitHits24h: 0,
      };
      snapshotsByAgentId.set(agentId, snapshot);
      return snapshot;
    };

    for (const row of budgetUsage) {
      ensureSnapshot(row.agent_id).budgetUsagePercent = clampPercent(
        Number(row.budget_usage_percent ?? 0),
      );
    }
    for (const row of rateWindows) {
      const snapshot = ensureSnapshot(row.agent_id);
      snapshot.currentConcurrency = Number(row.current_concurrency ?? 0);
      snapshot.currentRpm = Number(row.current_rpm ?? 0);
      snapshot.currentTpm = Number(row.current_tpm ?? 0);
    }
    for (const row of errorCounts) {
      const snapshot = ensureSnapshot(row.agent_id);
      snapshot.overLimitTodayCount = Number(row.over_limit_today_count ?? 0);
      snapshot.overLimitYesterdayCount = Number(row.over_limit_yesterday_count ?? 0);
      snapshot.rateLimitHits24h = Number(row.rate_limit_hits_24h ?? 0);
    }

    return Array.from(snapshotsByAgentId.values());
  });
}

export async function saveAgentLimitRules(input: {
  databaseUrl?: string;
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

export async function deleteAgentLimitRules(input: {
  agentId: string;
  databaseUrl?: string;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete Agent limits ${input.agentId}`,
    changes: [{ table: "agent_limits", recordId: input.agentId }],
    write: async (client) => {
      await assertAgentExists(client, input.agentId);
      await client.query("delete from agent_limits where agent_id = $1", [input.agentId]);
    },
  });
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
      manualOverride: buildManualPriceOverride({
        cachedInputUsdPerMillionTokens:
          candidate.price_override_cached_input_usd_per_million_tokens,
        inputUsdPerMillionTokens: candidate.price_override_input_usd_per_million_tokens,
        modelId: candidate.model_id,
        outputUsdPerMillionTokens: candidate.price_override_output_usd_per_million_tokens,
        providerKey: candidate.provider_key,
        updatedAt: candidate.price_override_updated_at,
      }),
      modelId: candidate.model_id,
      providerKey: candidate.provider_key,
      syncedPrice: buildSyncedPriceSnapshot({
        cachedInputUsdPerMillionTokens: candidate.price_sync_cached_input_usd_per_million_tokens,
        inputUsdPerMillionTokens: candidate.price_sync_input_usd_per_million_tokens,
        modelId: candidate.model_id,
        outputUsdPerMillionTokens: candidate.price_sync_output_usd_per_million_tokens,
        priceVersion: candidate.price_sync_price_version,
        providerKey: candidate.provider_key,
        sourceUrl: candidate.price_sync_source_url,
        syncedAt: candidate.price_sync_synced_at,
      }),
    });
    return price.status === "unknown_price";
  });

  if (missingPriceCandidates.length === 0) {
    return;
  }

  const candidateLabels = missingPriceCandidates
    .map((candidate) => {
      return `${candidate.virtual_model_display_name} (${candidate.virtual_model_name}) candidate ${candidate.provider_display_name} - ${candidate.model_display_name} (${candidate.model_id})`;
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
               virtual_models.description as display_name
        from agents
        join virtual_models
          on virtual_models.enabled = true
         and virtual_models.deleted_at is null
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
          and agents.deleted_at is null
      )
      select accessible_virtual_models.name as virtual_model_name,
             accessible_virtual_models.display_name as virtual_model_display_name,
             route_policy_candidates.candidate_order,
             providers.provider_key,
             providers.display_name as provider_display_name,
             provider_models.model_id,
             provider_models.display_name as model_display_name,
             provider_models.manual_input_usd_per_million_tokens::text as price_override_input_usd_per_million_tokens,
             provider_models.manual_cached_input_usd_per_million_tokens::text as price_override_cached_input_usd_per_million_tokens,
             provider_models.manual_output_usd_per_million_tokens::text as price_override_output_usd_per_million_tokens,
             provider_models.manual_price_updated_at as price_override_updated_at,
             provider_models.synced_input_usd_per_million_tokens::text as price_sync_input_usd_per_million_tokens,
             provider_models.synced_cached_input_usd_per_million_tokens::text as price_sync_cached_input_usd_per_million_tokens,
             provider_models.synced_output_usd_per_million_tokens::text as price_sync_output_usd_per_million_tokens,
             provider_models.synced_price_version as price_sync_price_version,
             provider_models.synced_price_source_url as price_sync_source_url,
             provider_models.synced_price_synced_at as price_sync_synced_at
      from accessible_virtual_models
      join route_policies on route_policies.virtual_model_id = accessible_virtual_models.id
      join route_policy_candidates on route_policy_candidates.route_policy_id = route_policies.id
      join provider_models on provider_models.id = route_policy_candidates.provider_model_id
      join providers on providers.id = provider_models.provider_id
      where providers.enabled = true
        and providers.deleted_at is null
        and provider_models.deleted_at is null
        and route_policies.deleted_at is null
        and provider_models.availability = 'available'
      order by accessible_virtual_models.name,
               route_policy_candidates.candidate_order,
               providers.provider_key,
               provider_models.model_id
    `,
    [agentId],
  );
  return result.rows;
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

async function readAgentLimitBudgetUsage(client: QueryClient): Promise<AgentLimitBudgetUsageRow[]> {
  const result = await client.query<AgentLimitBudgetUsageRow>(
    `
      select agent_limits.agent_id::text as agent_id,
             max(
               (
                 budget_periods.cost_used_usd / nullif(agent_limits.limit_value, 0)
               ) * 100
             )::text as budget_usage_percent
      from agent_limits
      join budget_periods
        on budget_periods.agent_id = agent_limits.agent_id
       and budget_periods.period_type = agent_limits.period
      where agent_limits.enabled = true
        and agent_limits.limit_type = 'budget'
        and now() >= budget_periods.period_start
        and now() < budget_periods.period_end
      group by agent_limits.agent_id
    `,
  );
  return result.rows;
}

async function readAgentLimitRateWindows(client: QueryClient): Promise<AgentLimitRateWindowRow[]> {
  const result = await client.query<AgentLimitRateWindowRow>(
    `
      select rate_limit_windows.agent_id::text as agent_id,
             max(rate_limit_windows.request_count)
               filter (where rate_limit_windows.limit_type = 'rpm') as current_rpm,
             max(rate_limit_windows.token_count)
               filter (where rate_limit_windows.limit_type = 'tpm') as current_tpm,
             max(rate_limit_windows.active_count)
               filter (where rate_limit_windows.limit_type = 'concurrency') as current_concurrency
      from rate_limit_windows
      where now() >= rate_limit_windows.window_start
        and now() < rate_limit_windows.window_end
      group by rate_limit_windows.agent_id
    `,
  );
  return result.rows;
}

async function readAgentLimitErrorCounts(client: QueryClient): Promise<AgentLimitErrorCountRow[]> {
  const result = await client.query<AgentLimitErrorCountRow>(
    `
      select request_activity.agent_id::text as agent_id,
             count(*) filter (
               where request_activity.error_code in (
                 'rate_limit_exceeded',
                 'cost_budget_exceeded',
                 'token_budget_exceeded'
               )
               and request_activity.started_at >= date_trunc('day', now())
             )::integer as over_limit_today_count,
             count(*) filter (
               where request_activity.error_code in (
                 'rate_limit_exceeded',
                 'cost_budget_exceeded',
                 'token_budget_exceeded'
               )
               and request_activity.started_at >= date_trunc('day', now()) - interval '1 day'
               and request_activity.started_at < date_trunc('day', now())
             )::integer as over_limit_yesterday_count,
             count(*) filter (
               where request_activity.error_code = 'rate_limit_exceeded'
                 and request_activity.started_at >= now() - interval '24 hours'
             )::integer as rate_limit_hits_24h
      from request_activity
      where request_activity.error_code in (
        'rate_limit_exceeded',
        'cost_budget_exceeded',
        'token_budget_exceeded'
      )
      group by request_activity.agent_id
    `,
  );
  return result.rows;
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

function normalizeAlertThresholdPercent(value: string | number | null | undefined): number {
  const rawValue = value ?? defaultAgentLimitFormValues.alertThresholdPercent;
  const numberValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!Number.isFinite(numberValue) || numberValue <= 0 || numberValue > 100) {
    throw new Error("Alert threshold must be greater than zero and no more than 100.");
  }
  return numberValue / 100;
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

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(999, value);
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
