import { randomUUID } from "node:crypto";
import { withPooledPostgresClient } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

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

  return {
    agentId,
    rules: [
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
          input.concurrency ?? defaultAgentLimitFormValues.concurrency,
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
  return withPooledPostgresClient(databaseUrl, (client) => readAgentLimits(client));
}

export async function listAgentLimitRuntimeSnapshots(
  databaseUrl?: string,
): Promise<ConsoleAgentLimitRuntimeSnapshot[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
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
              enforcement_policy,
              manual_bypass
            )
            values ($1, $2, $3, $4, $5, $6, true, $7, $8)
          `,
          [
            randomUUID(),
            input.limits.agentId,
            rule.limitType,
            rule.period,
            rule.limitValue,
            rule.unit,
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
    throw consoleNotFoundError("Agent was not found.", "agent_not_found", { agentId: id });
  }
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
             enforcement_policy,
             manual_bypass
      from agent_limits
      where ($1::uuid is null or agent_id = $1::uuid)
      order by agent_id, limit_type
    `,
    [agentId ?? null],
  );
  return result.rows.map((row) => ({
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
      "agent_limit_value_invalid",
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
