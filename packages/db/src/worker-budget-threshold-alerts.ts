import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/client";
import { type JobHandler, JobHandlerError } from "./worker-job-runner.ts";
import { queueNotificationEvent } from "./worker-notification-dispatcher.ts";

export type BudgetThresholdAlertSettings = {
  intervalMs: number;
  thresholdRatios: number[];
};

export type BudgetThresholdAlertPayload = {
  thresholdRatios: number[];
};

export type BudgetThresholdAlertsResult = {
  evaluatedBudgetCount: number;
  notificationEventCount: number;
  queuedAlertCount: number;
  skippedDuplicateAlertCount: number;
  skippedNoChannelCount: number;
  thresholdRatios: number[];
};

type CreateBudgetThresholdAlertsJobHandlerOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

type EvaluateBudgetThresholdAlertsOptions = CreateBudgetThresholdAlertsJobHandlerOptions & {
  payload: unknown;
};

type BudgetThresholdCandidateRow = PostgresQueryResultRow & {
  agent_key_prefix: string;
  agent_id: string;
  agent_name: string;
  budget_limit_usd: string;
  budget_period_id: string;
  cost_used_usd: string;
  period_end: Date;
  period_start: Date;
  period_type: string;
  reserved_cost_usd: string;
};

type BudgetThresholdCandidate = {
  agentApiKeyPrefix: string;
  agentId: string;
  agentName: string;
  budgetLimitUsd: number;
  budgetPeriodId: string;
  costUsedUsd: number;
  periodEnd: Date;
  periodStart: Date;
  periodType: string;
  reservedCostUsd: number;
};

const defaultBudgetThresholdAlertIntervalMs = 15 * 60 * 1000;
const defaultBudgetWarningThresholdRatios = [0.8, 0.9];

export function createBudgetThresholdAlertsJobHandler(
  options: CreateBudgetThresholdAlertsJobHandlerOptions,
): JobHandler {
  return async (job) =>
    evaluateBudgetThresholdAlerts({
      ...options,
      payload: job.payload,
    });
}

export async function evaluateBudgetThresholdAlerts(
  options: EvaluateBudgetThresholdAlertsOptions,
): Promise<BudgetThresholdAlertsResult> {
  const payload = readBudgetThresholdAlertPayload(options.payload);
  const now = options.now?.() ?? new Date();
  const candidates = await readBudgetThresholdCandidates(options.databaseUrl, now);
  const enabledChannelCount = await readEnabledNotificationChannelCount(options.databaseUrl);
  const result: BudgetThresholdAlertsResult = {
    evaluatedBudgetCount: candidates.length,
    notificationEventCount: 0,
    queuedAlertCount: 0,
    skippedDuplicateAlertCount: 0,
    skippedNoChannelCount: 0,
    thresholdRatios: payload.thresholdRatios,
  };

  for (const candidate of candidates) {
    const usedCostUsd = candidate.costUsedUsd + candidate.reservedCostUsd;
    const usageRatio = usedCostUsd / candidate.budgetLimitUsd;

    for (const thresholdRatio of payload.thresholdRatios) {
      if (usageRatio < thresholdRatio) {
        continue;
      }

      const event = buildBudgetThresholdNotificationEvent({
        candidate,
        thresholdRatio,
        usageRatio,
        usedCostUsd,
      });
      if (await budgetThresholdAlertAlreadyQueued(options.databaseUrl, event.payload.alertKey)) {
        result.skippedDuplicateAlertCount += 1;
        continue;
      }
      if (enabledChannelCount === 0) {
        result.skippedNoChannelCount += 1;
        continue;
      }

      const queued = await queueNotificationEvent({
        databaseUrl: options.databaseUrl,
        event,
        now: () => now,
      });
      result.queuedAlertCount += 1;
      result.notificationEventCount += queued.eventIds.length;
    }
  }

  return result;
}

export function readBudgetThresholdAlertSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): BudgetThresholdAlertSettings {
  return {
    intervalMs: readPositiveIntegerEnv(
      env.BUDGET_THRESHOLD_ALERT_INTERVAL_MS,
      defaultBudgetThresholdAlertIntervalMs,
      "BUDGET_THRESHOLD_ALERT_INTERVAL_MS",
    ),
    thresholdRatios: readThresholdRatiosEnv(
      env.BUDGET_WARNING_THRESHOLDS,
      defaultBudgetWarningThresholdRatios,
    ),
  };
}

export function readBudgetThresholdAlertPayload(payload: unknown): BudgetThresholdAlertPayload {
  const rawPayload = readObject(payload);
  const thresholdRatios =
    rawPayload.thresholdRatios === undefined
      ? readBudgetThresholdAlertSettings().thresholdRatios
      : normalizeThresholdRatios(rawPayload.thresholdRatios, "thresholdRatios");

  return { thresholdRatios };
}

function buildBudgetThresholdNotificationEvent(input: {
  candidate: BudgetThresholdCandidate;
  thresholdRatio: number;
  usageRatio: number;
  usedCostUsd: number;
}) {
  const roundedUsageRatio = roundRatio(input.usageRatio);
  const payload = {
    agentApiKeyPrefix: input.candidate.agentApiKeyPrefix,
    agentId: input.candidate.agentId,
    agentName: input.candidate.agentName,
    alertKey: `budget_threshold:${input.candidate.budgetPeriodId}:${input.thresholdRatio}`,
    budgetLimitUsd: roundUsd(input.candidate.budgetLimitUsd),
    budgetPeriodId: input.candidate.budgetPeriodId,
    costUsedUsd: roundUsd(input.candidate.costUsedUsd),
    periodEnd: input.candidate.periodEnd.toISOString(),
    periodStart: input.candidate.periodStart.toISOString(),
    periodType: input.candidate.periodType,
    reservedCostUsd: roundUsd(input.candidate.reservedCostUsd),
    thresholdRatio: input.thresholdRatio,
    usageRatio: roundedUsageRatio,
    usedCostUsd: roundUsd(input.usedCostUsd),
  };

  return {
    body: `${input.candidate.agentName} budget usage is at ${Math.round(
      roundedUsageRatio * 100,
    )}% of the ${input.candidate.periodType} budget.`,
    eventType: "budget_threshold",
    maxAttempts: 3,
    payload,
    subject: "Budget threshold warning",
  };
}

async function readBudgetThresholdCandidates(
  databaseUrl: string | undefined,
  now: Date,
): Promise<BudgetThresholdCandidate[]> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<BudgetThresholdCandidateRow>(
      `
        select budget_periods.id::text as budget_period_id,
               budget_periods.period_type,
               budget_periods.period_start,
               budget_periods.period_end,
               budget_periods.cost_used_usd::text,
               budget_periods.reserved_cost_usd::text,
               agent_limits.limit_value::text as budget_limit_usd,
               agents.key_prefix as agent_key_prefix,
               agents.id::text as agent_id,
               agents.name as agent_name
        from budget_periods
        join agent_limits on agent_limits.agent_id = budget_periods.agent_id
        join agents on agents.id = budget_periods.agent_id
        where agent_limits.enabled = true
          and agent_limits.limit_type = 'budget'
          and agent_limits.unit = 'usd'
          and agent_limits.period = budget_periods.period_type
          and agents.enabled = true
          and agents.deleted_at is null
          and budget_periods.period_start <= $1::timestamptz
          and budget_periods.period_end > $1::timestamptz
        order by agents.name, agents.key_prefix, budget_periods.period_start
      `,
      [now.toISOString()],
    );
    return result.rows.map(rowToBudgetThresholdCandidate);
  } finally {
    await client.end();
  }
}

function rowToBudgetThresholdCandidate(row: BudgetThresholdCandidateRow): BudgetThresholdCandidate {
  return {
    agentApiKeyPrefix: row.agent_key_prefix,
    agentId: row.agent_id,
    agentName: row.agent_name,
    budgetLimitUsd: Number(row.budget_limit_usd),
    budgetPeriodId: row.budget_period_id,
    costUsedUsd: Number(row.cost_used_usd),
    periodEnd: row.period_end,
    periodStart: row.period_start,
    periodType: row.period_type,
    reservedCostUsd: Number(row.reserved_cost_usd),
  };
}

async function readEnabledNotificationChannelCount(databaseUrl?: string): Promise<number> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from notification_channels where enabled = true and channel_type = 'webhook'",
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function budgetThresholdAlertAlreadyQueued(
  databaseUrl: string | undefined,
  alertKey: string,
): Promise<boolean> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from notification_events
          where event_type = 'budget_threshold'
            and payload ->> 'alertKey' = $1
        ) as exists
      `,
      [alertKey],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

function readThresholdRatiosEnv(value: string | undefined, defaultValue: number[]): number[] {
  if (value === undefined) {
    return defaultValue;
  }

  return normalizeThresholdRatios(
    value.split(",").map((part) => Number(part.trim())),
    "BUDGET_WARNING_THRESHOLDS",
  );
}

function normalizeThresholdRatios(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new JobHandlerError(
      "budget_threshold_alerts_invalid_thresholds",
      `${label} must contain one or more thresholdRatios.`,
    );
  }

  const seen = new Set<number>();
  const thresholds = value.map((candidate) => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new JobHandlerError(
        "budget_threshold_alerts_invalid_thresholds",
        `${label} must contain numeric thresholdRatios.`,
      );
    }
    if (candidate <= 0 || candidate > 1) {
      throw new JobHandlerError(
        "budget_threshold_alerts_invalid_thresholds",
        `${label} thresholdRatios must be greater than 0 and at most 1.`,
      );
    }

    const rounded = roundRatio(candidate);
    if (seen.has(rounded)) {
      throw new JobHandlerError(
        "budget_threshold_alerts_invalid_thresholds",
        `${label} thresholdRatios must not contain duplicates.`,
      );
    }
    seen.add(rounded);
    return rounded;
  });

  return thresholds.sort((left, right) => left - right);
}

function readPositiveIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function roundRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
