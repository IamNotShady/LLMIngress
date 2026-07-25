import { randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

export type {
  ApiKeyLimitEnforcementPolicy,
  ApiKeyLimitPeriod,
  ApiKeyLimitType,
  ApiKeyLimitUnit,
} from "@llmingress/domain";

import type {
  ApiKeyLimitEnforcementPolicy,
  ApiKeyLimitPeriod,
  ApiKeyLimitType,
  ApiKeyLimitUnit,
} from "@llmingress/domain";

export type ApiKeyLimitRuleInput = {
  enforcementPolicy?: ApiKeyLimitEnforcementPolicy;
  limitType: ApiKeyLimitType;
  limitValue: number;
  manualBypass?: boolean;
  period: ApiKeyLimitPeriod;
  unit: ApiKeyLimitUnit;
};

export type ApiKeyLimitFormInput = {
  apiKeyId?: string | null;
  budgetPeriod?: string | null;
  budgetUsd?: string | number | null;
  concurrency?: string | number | null;
  rpm?: string | number | null;
  tokenLimit?: string | number | null;
  tpm?: string | number | null;
};

export type NormalizedApiKeyLimitFormInput = {
  apiKeyId: string;
  rules: ApiKeyLimitRuleInput[];
};

export type ConsoleApiKeyLimit = ApiKeyLimitRuleInput & {
  apiKeyId: string;
  enabled: boolean;
  id: string;
};

export type ConsoleApiKeyLimitRuntimeSnapshot = {
  apiKeyId: string;
  budgetUsagePercent: number;
  currentConcurrency: number;
  currentRpm: number;
  currentTpm: number;
  overLimitTodayCount: number;
  overLimitYesterdayCount: number;
  rateLimitHits24h: number;
};

type ApiKeyLimitRow = {
  api_key_id: string;
  enabled: boolean;
  enforcement_policy: ApiKeyLimitEnforcementPolicy;
  id: string;
  limit_type: ApiKeyLimitType;
  limit_value: string;
  manual_bypass: boolean;
  period: ApiKeyLimitPeriod;
  unit: ApiKeyLimitUnit;
};

type ApiKeyLimitBudgetUsageRow = {
  api_key_id: string;
  budget_usage_percent: string | null;
};

type ApiKeyLimitRateWindowRow = {
  api_key_id: string;
  current_concurrency: number | null;
  current_rpm: number | null;
  current_tpm: number | null;
};

type ApiKeyLimitErrorCountRow = {
  api_key_id: string;
  over_limit_today_count: number;
  over_limit_yesterday_count: number;
  rate_limit_hits_24h: number;
};

export type ApiKeyLimitQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

const budgetPeriods = ["day", "week", "month"] as const;

export const defaultApiKeyLimitFormValues = {
  budgetPeriod: "month",
  budgetUsd: 10,
  concurrency: 10,
  rpm: 60,
  tokenLimit: 200_000,
  tpm: 1_000_000,
} as const;

export function normalizeApiKeyLimitFormInput(
  input: ApiKeyLimitFormInput,
): NormalizedApiKeyLimitFormInput {
  const apiKeyId = normalizeRequiredText(input.apiKeyId, "API key id");
  return { apiKeyId, rules: normalizeApiKeyLimitRulesInput(input) };
}

export function normalizeApiKeyLimitRulesInput(
  input: Omit<ApiKeyLimitFormInput, "apiKeyId">,
): ApiKeyLimitRuleInput[] {
  const budgetPeriod = normalizeBudgetPeriod(input.budgetPeriod);

  return [
    {
      enforcementPolicy: "block",
      limitType: "budget",
      limitValue: normalizePositiveNumber(input.budgetUsd, "Budget USD limit"),
      manualBypass: false,
      period: budgetPeriod,
      unit: "usd",
    },
    {
      enforcementPolicy: "block",
      limitType: "rpm",
      limitValue: normalizePositiveNumber(input.rpm, "RPM limit"),
      manualBypass: false,
      period: "minute",
      unit: "requests",
    },
    {
      enforcementPolicy: "block",
      limitType: "tpm",
      limitValue: normalizePositiveNumber(input.tpm, "TPM limit"),
      manualBypass: false,
      period: "minute",
      unit: "tokens",
    },
    {
      enforcementPolicy: "block",
      limitType: "concurrency",
      limitValue: normalizePositiveNumber(
        input.concurrency ?? defaultApiKeyLimitFormValues.concurrency,
        "Concurrency limit",
      ),
      manualBypass: false,
      period: "request",
      unit: "requests",
    },
    {
      enforcementPolicy: "block",
      limitType: "token",
      limitValue: normalizePositiveNumber(input.tokenLimit, "Token limit"),
      manualBypass: false,
      period: "request",
      unit: "tokens",
    },
  ];
}

export function formatApiKeyLimitSummaries(
  limits: readonly ConsoleApiKeyLimit[],
): Record<ApiKeyLimitType, string> {
  return {
    budget: formatLimitSummary(limits.find((limit) => limit.limitType === "budget")),
    concurrency: formatLimitSummary(limits.find((limit) => limit.limitType === "concurrency")),
    rpm: formatLimitSummary(limits.find((limit) => limit.limitType === "rpm")),
    token: formatLimitSummary(limits.find((limit) => limit.limitType === "token")),
    tpm: formatLimitSummary(limits.find((limit) => limit.limitType === "tpm")),
  };
}

export async function listApiKeyLimits(databaseUrl?: string): Promise<ConsoleApiKeyLimit[]> {
  return withPooledPostgresClient(databaseUrl, (client) => readVisibleApiKeyLimits(client));
}

export async function listSavedApiKeyLimits(databaseUrl?: string): Promise<ConsoleApiKeyLimit[]> {
  return withPooledPostgresClient(databaseUrl, (client) => readApiKeyLimitsWithClient(client));
}

export async function listApiKeyLimitRuntimeSnapshots(
  databaseUrl?: string,
): Promise<ConsoleApiKeyLimitRuntimeSnapshot[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const budgetUsage = await readApiKeyLimitBudgetUsage(client);
    const rateWindows = await readApiKeyLimitRateWindows(client);
    const errorCounts = await readApiKeyLimitErrorCounts(client);
    const snapshotsByApiKeyId = new Map<string, ConsoleApiKeyLimitRuntimeSnapshot>();
    const ensureSnapshot = (apiKeyId: string) => {
      const existing = snapshotsByApiKeyId.get(apiKeyId);
      if (existing) {
        return existing;
      }
      const snapshot: ConsoleApiKeyLimitRuntimeSnapshot = {
        apiKeyId,
        budgetUsagePercent: 0,
        currentConcurrency: 0,
        currentRpm: 0,
        currentTpm: 0,
        overLimitTodayCount: 0,
        overLimitYesterdayCount: 0,
        rateLimitHits24h: 0,
      };
      snapshotsByApiKeyId.set(apiKeyId, snapshot);
      return snapshot;
    };

    for (const row of budgetUsage) {
      ensureSnapshot(row.api_key_id).budgetUsagePercent = clampPercent(
        Number(row.budget_usage_percent ?? 0),
      );
    }
    for (const row of rateWindows) {
      const snapshot = ensureSnapshot(row.api_key_id);
      snapshot.currentConcurrency = Number(row.current_concurrency ?? 0);
      snapshot.currentRpm = Number(row.current_rpm ?? 0);
      snapshot.currentTpm = Number(row.current_tpm ?? 0);
    }
    for (const row of errorCounts) {
      const snapshot = ensureSnapshot(row.api_key_id);
      snapshot.overLimitTodayCount = Number(row.over_limit_today_count ?? 0);
      snapshot.overLimitYesterdayCount = Number(row.over_limit_yesterday_count ?? 0);
      snapshot.rateLimitHits24h = Number(row.rate_limit_hits_24h ?? 0);
    }

    return Array.from(snapshotsByApiKeyId.values());
  });
}

export async function saveApiKeyLimitRules(input: {
  databaseUrl?: string;
  limits: NormalizedApiKeyLimitFormInput;
}): Promise<ConsoleApiKeyLimit[]> {
  let savedLimits: ConsoleApiKeyLimit[] | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update API key limits ${input.limits.apiKeyId}`,
    changes: [{ table: "api_key_limits", recordId: input.limits.apiKeyId }],
    write: async (client) => {
      await assertApiKeyExists(client, input.limits.apiKeyId);
      await replaceApiKeyLimitRulesWithClient(client, input.limits.apiKeyId, input.limits.rules);

      savedLimits = await readApiKeyLimitsWithClient(client, input.limits.apiKeyId);
    },
  });

  if (!savedLimits) {
    throw new Error("API key limits were not saved.");
  }
  return savedLimits;
}

export async function replaceApiKeyLimitRulesWithClient(
  client: ApiKeyLimitQueryClient,
  apiKeyId: string,
  rules: readonly ApiKeyLimitRuleInput[],
): Promise<void> {
  await client.query(
    `
      delete from api_key_limits
      where api_key_id = $1
        and limit_type = any($2::text[])
    `,
    [apiKeyId, rules.map((rule) => rule.limitType)],
  );

  for (const rule of rules) {
    await client.query(
      `
        insert into api_key_limits (
          id,
          api_key_id,
          limit_type,
          period,
          limit_value,
          unit,
          enabled,
          enforcement_policy,
          manual_bypass
        )
        values ($1, $2, $3, $4, $5, $6, true, $7, $8)
      `,
      [
        randomUUID(),
        apiKeyId,
        rule.limitType,
        rule.period,
        rule.limitValue,
        rule.unit,
        rule.enforcementPolicy ?? "block",
        rule.manualBypass ?? false,
      ],
    );
  }
}

export async function deleteApiKeyLimitRules(input: {
  apiKeyId: string;
  databaseUrl?: string;
}): Promise<void> {
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete API key limits ${input.apiKeyId}`,
    changes: [{ table: "api_key_limits", recordId: input.apiKeyId }],
    write: async (client) => {
      await assertApiKeyExists(client, input.apiKeyId);
      await client.query("delete from api_key_limits where api_key_id = $1", [input.apiKeyId]);
    },
  });
}

async function assertApiKeyExists(client: ApiKeyLimitQueryClient, id: string): Promise<void> {
  const result = await client.query("select 1 from api_keys where id = $1 for update", [id]);
  if (!result.rows[0]) {
    throw consoleNotFoundError("API key was not found.", "api_key_not_found", { apiKeyId: id });
  }
}

export async function readApiKeyLimitsWithClient(
  client: ApiKeyLimitQueryClient,
  apiKeyId?: string,
): Promise<ConsoleApiKeyLimit[]> {
  const result = await client.query<ApiKeyLimitRow>(
    `
      select id::text,
             api_key_id::text as api_key_id,
             limit_type,
             period,
             limit_value::text,
             unit,
             enabled,
             enforcement_policy,
             manual_bypass
      from api_key_limits
      where ($1::uuid is null or api_key_id = $1::uuid)
      order by api_key_id, limit_type
    `,
    [apiKeyId ?? null],
  );
  return result.rows.map((row) => ({
    apiKeyId: row.api_key_id,
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

async function readVisibleApiKeyLimits(
  client: ApiKeyLimitQueryClient,
): Promise<ConsoleApiKeyLimit[]> {
  const result = await client.query<ApiKeyLimitRow>(
    `
      select api_key_limits.id::text,
             api_key_limits.api_key_id::text as api_key_id,
             api_key_limits.limit_type,
             api_key_limits.period,
             api_key_limits.limit_value::text,
             api_key_limits.unit,
             api_key_limits.enabled,
             api_key_limits.enforcement_policy,
             api_key_limits.manual_bypass
      from api_key_limits
      inner join api_keys on api_keys.id = api_key_limits.api_key_id
      where api_keys.enabled = true
        and api_keys.limits_enabled = true
        and api_keys.deleted_at is null
      order by api_key_limits.api_key_id, api_key_limits.limit_type
    `,
  );
  return result.rows.map((row) => ({
    apiKeyId: row.api_key_id,
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

async function readApiKeyLimitBudgetUsage(
  client: ApiKeyLimitQueryClient,
): Promise<ApiKeyLimitBudgetUsageRow[]> {
  const result = await client.query<ApiKeyLimitBudgetUsageRow>(
    `
      select api_key_limits.api_key_id::text as api_key_id,
             max(
               (
                 budget_periods.cost_used_usd / nullif(api_key_limits.limit_value, 0)
               ) * 100
             )::text as budget_usage_percent
      from api_key_limits
      join api_keys on api_keys.id = api_key_limits.api_key_id
      join budget_periods
        on budget_periods.api_key_id = api_key_limits.api_key_id
       and budget_periods.period_type = api_key_limits.period
      where api_key_limits.enabled = true
        and api_keys.enabled = true
        and api_keys.limits_enabled = true
        and api_keys.deleted_at is null
        and api_key_limits.limit_type = 'budget'
        and now() >= budget_periods.period_start
        and now() < budget_periods.period_end
      group by api_key_limits.api_key_id
    `,
  );
  return result.rows;
}

async function readApiKeyLimitRateWindows(
  client: ApiKeyLimitQueryClient,
): Promise<ApiKeyLimitRateWindowRow[]> {
  const result = await client.query<ApiKeyLimitRateWindowRow>(
    `
      select rate_limit_windows.api_key_id::text as api_key_id,
             max(rate_limit_windows.request_count)
               filter (where rate_limit_windows.limit_type = 'rpm') as current_rpm,
             max(rate_limit_windows.token_count)
               filter (where rate_limit_windows.limit_type = 'tpm') as current_tpm,
             max(rate_limit_windows.active_count)
               filter (where rate_limit_windows.limit_type = 'concurrency') as current_concurrency
      from rate_limit_windows
      join api_keys on api_keys.id = rate_limit_windows.api_key_id
      where now() >= rate_limit_windows.window_start
        and now() < rate_limit_windows.window_end
        and api_keys.enabled = true
        and api_keys.limits_enabled = true
        and api_keys.deleted_at is null
      group by rate_limit_windows.api_key_id
    `,
  );
  return result.rows;
}

async function readApiKeyLimitErrorCounts(
  client: ApiKeyLimitQueryClient,
): Promise<ApiKeyLimitErrorCountRow[]> {
  const result = await client.query<ApiKeyLimitErrorCountRow>(
    `
      select request_activity.api_key_id::text as api_key_id,
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
      join api_keys on api_keys.id = request_activity.api_key_id
      where request_activity.error_code in (
        'rate_limit_exceeded',
        'cost_budget_exceeded',
        'token_budget_exceeded'
      )
        and api_keys.enabled = true
        and api_keys.limits_enabled = true
        and api_keys.deleted_at is null
      group by request_activity.api_key_id
    `,
  );
  return result.rows;
}

function formatLimitSummary(limit: ConsoleApiKeyLimit | undefined): string {
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
    throw consoleValidationError(
      "Budget period must be day, week, or month.",
      "budget_period_invalid",
    );
  }
  return period as (typeof budgetPeriods)[number];
}

function normalizePositiveNumber(value: string | number | null | undefined, label: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw consoleValidationError(
      `${label} must be greater than zero.`,
      "api_key_limit_value_invalid",
      {
        field: label,
      },
    );
  }
  return numberValue;
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw consoleValidationError(`${label} is required.`, "form_field_required", { field: label });
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

/** The budget window a key is inside right now — what SPENT is measured against. */
export type ConsoleBudgetPeriod = {
  apiKeyId: string;
  costUsedUsd: string;
  periodEnd: Date;
  periodStart: Date;
  periodType: string;
  tokensUsed: number;
};

export async function listConsoleCurrentBudgetPeriods(
  input: { databaseUrl?: string; now?: Date } = {},
): Promise<ConsoleBudgetPeriod[]> {
  const now = input.now ?? new Date();
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<{
      api_key_id: string;
      cost_used_usd: string;
      period_end: Date;
      period_start: Date;
      period_type: string;
      tokens_used: string;
    }>(
      `
        select distinct on (api_key_id)
               api_key_id::text,
               cost_used_usd::text,
               period_end,
               period_start,
               period_type,
               tokens_used::text
        from budget_periods
        where period_start <= $1 and period_end > $1
        order by api_key_id, period_start desc
      `,
      [now.toISOString()],
    );
    return result.rows.map((row) => ({
      apiKeyId: row.api_key_id,
      costUsedUsd: row.cost_used_usd,
      periodEnd: row.period_end,
      periodStart: row.period_start,
      periodType: row.period_type,
      tokensUsed: Number(row.tokens_used),
    }));
  });
}
