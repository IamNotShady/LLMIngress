import { randomUUID } from "node:crypto";
import { calculateTokenCostUsd, type ModelTokenPrice } from "@llmingress/billing/price-registry";
import {
  getPostgresPool,
  type PostgresQueryClient,
  withPostgresTransaction,
} from "@llmingress/db/client";
import type {
  AgentLimitEnforcementPolicy,
  AgentLimitPeriod,
  AgentLimitType,
} from "@llmingress/domain";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";
import {
  buildGatewayUsageCostRecords,
  type GatewayUsageCostDetails,
} from "./gateway-usage-recorder.ts";

export type GatewayAgentLimitType = AgentLimitType;
export type GatewayAgentLimitEnforcementPolicy = AgentLimitEnforcementPolicy;
export type GatewayRateLimitType = Extract<AgentLimitType, "concurrency" | "rpm" | "tpm">;
export type GatewayBudgetPeriod = Extract<AgentLimitPeriod, "day" | "hour" | "month" | "week">;

export type GatewayAgentLimitErrorCode =
  | "cost_budget_exceeded"
  | "rate_limit_exceeded"
  | "token_budget_exceeded";

export type GatewayEnabledAgentLimit = {
  enforcementPolicy: GatewayAgentLimitEnforcementPolicy;
  limitType: GatewayAgentLimitType;
  limitValue: number;
  manualBypass: boolean;
  period: string;
  unit: string;
};

export type GatewayConcurrencyLease = {
  agentId: string;
  window: WindowBoundary;
};

export type GatewayBudgetSettlement = {
  periodEnd: Date;
  periodStart: Date;
  periodType: GatewayBudgetPeriod;
};

export type GatewayAgentLimitErrorBody = {
  error: {
    code: GatewayAgentLimitErrorCode;
    message: string;
  };
  limitType?: GatewayRateLimitType;
  requestId: string;
  retryAfterMs?: number;
  retryAfterSeconds?: number;
};

export type GatewayAgentLimitDecision =
  | {
      budgetSettlement?: GatewayBudgetSettlement;
      concurrencyLease?: GatewayConcurrencyLease;
      ok: true;
    }
  | {
      body: GatewayAgentLimitErrorBody;
      ok: false;
      retryAfterSeconds?: number;
      statusCode: 402 | 429;
    };

type AgentLimitRow = {
  enforcement_policy: GatewayAgentLimitEnforcementPolicy;
  limit_type: GatewayAgentLimitType;
  limit_value: string;
  manual_bypass: boolean;
  period: string;
  unit: string;
};

type RateLimitWindowRow = {
  active_count: number;
  request_count: number;
  token_count: number;
};

type BudgetPeriodCostRow = {
  cost_used_usd: string;
};

type WindowBoundary = {
  windowEnd: Date;
  windowStart: Date;
};

export async function readEnabledGatewayAgentLimits(input: {
  agentId: string;
  databaseUrl?: string;
}): Promise<GatewayEnabledAgentLimit[]> {
  const result = await getPostgresPool(input.databaseUrl).query<AgentLimitRow>(
    `
      select limit_type,
             period,
             limit_value::text,
             unit,
             enforcement_policy,
             manual_bypass
      from agent_limits
      where agent_id = $1
        and enabled = true
        and limit_type in ('budget', 'concurrency', 'rpm', 'token', 'tpm')
    `,
    [input.agentId],
  );

  return result.rows.map((row) => ({
    enforcementPolicy: row.enforcement_policy,
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    manualBypass: row.manual_bypass,
    period: row.period,
    unit: row.unit,
  }));
}

export async function enforceGatewayAgentLimits(input: {
  agentId: string;
  budgetPrice?: ModelTokenPrice;
  databaseUrl?: string;
  enabledLimits?: readonly GatewayEnabledAgentLimit[];
  requestId: string;
  requestMetadata: GatewayRequestMetadata;
}): Promise<GatewayAgentLimitDecision> {
  const enabledLimits =
    input.enabledLimits ??
    (await readEnabledGatewayAgentLimits({
      agentId: input.agentId,
      databaseUrl: input.databaseUrl,
    }));

  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const now = new Date();
    const budgetDecision = await evaluateBudgetLimits(client, {
      agentId: input.agentId,
      budgetPrice: input.budgetPrice,
      enabledLimits,
      now,
      requestId: input.requestId,
      requestMetadata: input.requestMetadata,
    });
    if (!budgetDecision.ok) {
      return budgetDecision;
    }

    const rateLimitDecision = await evaluateAndIncrementRateLimits(client, {
      agentId: input.agentId,
      enabledLimits,
      now,
      requestId: input.requestId,
      requestMetadata: input.requestMetadata,
    });
    if (!rateLimitDecision.ok) {
      return rateLimitDecision;
    }

    return {
      budgetSettlement: budgetDecision.budgetSettlement,
      concurrencyLease: rateLimitDecision.concurrencyLease,
      ok: true,
    };
  });
}

export async function releaseGatewayConcurrency(input: {
  databaseUrl?: string;
  lease: GatewayConcurrencyLease | undefined;
}): Promise<void> {
  if (!input.lease) {
    return;
  }

  await getPostgresPool(input.databaseUrl).query(
    `
      update rate_limit_windows
      set active_count = greatest(active_count - 1, 0),
          updated_at = now()
      where agent_id = $1
        and limit_type = 'concurrency'
        and window_start = $2
    `,
    [input.lease.agentId, input.lease.window.windowStart],
  );
}

export async function recordGatewayBudgetUsage(input: {
  agentId: string;
  budgetSettlement: GatewayBudgetSettlement | undefined;
  databaseUrl?: string;
  requestId: string;
  usageCost: GatewayUsageCostDetails;
}): Promise<void> {
  if (!input.budgetSettlement) {
    return;
  }
  const budgetSettlement = input.budgetSettlement;

  const records = buildGatewayUsageCostRecords(input.usageCost);
  if (records.requestCost.totalCostUsd === null) {
    return;
  }

  await withPostgresTransaction(input.databaseUrl, async (client) => {
    await client.query(
      `
        insert into budget_periods (
          id,
          agent_id,
          period_type,
          period_start,
          period_end
        )
        values ($1, $2, $3, $4, $5)
        on conflict (agent_id, period_type, period_start) do nothing
      `,
      [
        randomUUID(),
        input.agentId,
        budgetSettlement.periodType,
        budgetSettlement.periodStart,
        budgetSettlement.periodEnd,
      ],
    );
    await client.query(
      `
        update budget_periods
        set tokens_used = tokens_used + $1,
            cost_used_usd = cost_used_usd + $2,
            updated_at = now()
        where agent_id = $3
          and period_type = $4
          and period_start = $5
      `,
      [
        records.requestUsage.totalTokens,
        records.requestCost.totalCostUsd,
        input.agentId,
        budgetSettlement.periodType,
        budgetSettlement.periodStart,
      ],
    );
  });
}

async function evaluateAndIncrementRateLimits(
  client: PostgresQueryClient,
  input: {
    agentId: string;
    enabledLimits: readonly GatewayEnabledAgentLimit[];
    now: Date;
    requestId: string;
    requestMetadata: GatewayRequestMetadata;
  },
): Promise<GatewayAgentLimitDecision> {
  const limits = readEnabledGatewayRateLimits(input.enabledLimits);
  if (limits.length === 0) {
    return { ok: true };
  }

  const minuteWindow = getMinuteWindow(input.now);
  const increments = limits.map((limit) => ({
    enforcementPolicy: limit.enforcementPolicy,
    increment:
      limit.limitType === "rpm"
        ? 1
        : limit.limitType === "tpm"
          ? input.requestMetadata.estimatedInputTokens + input.requestMetadata.estimatedOutputTokens
          : 1,
    limitType: limit.limitType,
    limitValue: limit.limitValue,
    manualBypass: limit.manualBypass,
    window: limit.limitType === "concurrency" ? getConcurrencyWindow() : minuteWindow,
  }));

  for (const increment of increments) {
    const currentCount = await lockRateLimitWindow(client, {
      agentId: input.agentId,
      limitType: increment.limitType,
      window: increment.window,
    });
    const decision = evaluateGatewayRateLimitWindow({
      currentCount:
        increment.limitType === "rpm"
          ? currentCount.requestCount
          : increment.limitType === "tpm"
            ? currentCount.tokenCount
            : currentCount.activeCount,
      enforcementPolicy: increment.enforcementPolicy,
      increment: increment.increment,
      limitType: increment.limitType,
      limitValue: increment.limitValue,
      manualBypass: increment.manualBypass,
      requestId: input.requestId,
      retryAfterMs:
        increment.limitType === "concurrency"
          ? 1
          : Math.max(1, minuteWindow.windowEnd.getTime() - input.now.getTime()),
    });
    if (!decision.ok) {
      return decision;
    }
  }

  for (const increment of increments) {
    await incrementRateLimitWindow(client, {
      agentId: input.agentId,
      increment: increment.increment,
      limitType: increment.limitType,
      window: increment.window,
    });
  }

  const concurrencyIncrement = increments.find(
    (increment) => increment.limitType === "concurrency",
  );
  return {
    concurrencyLease: concurrencyIncrement
      ? { agentId: input.agentId, window: concurrencyIncrement.window }
      : undefined,
    ok: true,
  };
}

async function evaluateBudgetLimits(
  client: PostgresQueryClient,
  input: {
    agentId: string;
    budgetPrice: ModelTokenPrice | undefined;
    enabledLimits: readonly GatewayEnabledAgentLimit[];
    now: Date;
    requestId: string;
    requestMetadata: GatewayRequestMetadata;
  },
): Promise<GatewayAgentLimitDecision> {
  const limits = readEnabledBudgetLimits(input.enabledLimits);
  const totalTokens =
    input.requestMetadata.estimatedInputTokens + input.requestMetadata.estimatedOutputTokens;

  const tokenLimit = limits.find(
    (limit) => limit.limitType === "token" && limit.period === "request" && limit.unit === "tokens",
  );
  if (tokenLimit && totalTokens > tokenLimit.limitValue) {
    return budgetFailure("token_budget_exceeded", input.requestId);
  }

  const costLimit = limits.find(
    (limit) => limit.limitType === "budget" && limit.unit === "usd" && isBudgetPeriod(limit.period),
  );
  if (!costLimit || !isBudgetPeriod(costLimit.period)) {
    return { ok: true };
  }

  const period = getBudgetPeriodWindow(input.now, costLimit.period);
  if (!input.budgetPrice || input.budgetPrice.status === "unknown_price") {
    return {
      budgetSettlement: {
        periodEnd: period.windowEnd,
        periodStart: period.windowStart,
        periodType: costLimit.period,
      },
      ok: true,
    };
  }

  const estimate = calculateTokenCostUsd(input.budgetPrice, {
    inputTokens: input.requestMetadata.estimatedInputTokens,
    outputTokens: input.requestMetadata.estimatedOutputTokens,
  });
  if (estimate.status !== "estimated") {
    throw new Error("Priced budget candidate cost could not be calculated.");
  }

  const currentCostUsd = await readCurrentBudgetPeriodCost(client, {
    agentId: input.agentId,
    period,
    periodType: costLimit.period,
  });
  if (currentCostUsd + estimate.totalCostUsd > costLimit.limitValue) {
    return budgetFailure("cost_budget_exceeded", input.requestId);
  }

  return {
    budgetSettlement: {
      periodEnd: period.windowEnd,
      periodStart: period.windowStart,
      periodType: costLimit.period,
    },
    ok: true,
  };
}

function evaluateGatewayRateLimitWindow(input: {
  currentCount: number;
  enforcementPolicy?: GatewayAgentLimitEnforcementPolicy;
  increment: number;
  limitType: GatewayRateLimitType;
  limitValue: number;
  manualBypass?: boolean;
  requestId: string;
  retryAfterMs: number;
}): GatewayAgentLimitDecision {
  if (input.currentCount + input.increment <= input.limitValue) {
    return { ok: true };
  }
  if (input.manualBypass || input.enforcementPolicy === "warn_only") {
    return { ok: true };
  }

  const body = createGatewayRateLimitErrorBody({
    limitType: input.limitType,
    requestId: input.requestId,
    retryAfterMs: input.retryAfterMs,
  });

  return {
    body,
    ok: false,
    retryAfterSeconds: body.retryAfterSeconds,
    statusCode: 429,
  };
}

function createGatewayRateLimitErrorBody(input: {
  limitType: GatewayRateLimitType;
  requestId: string;
  retryAfterMs: number;
}): GatewayAgentLimitErrorBody {
  const retryAfterSeconds = Math.max(1, Math.ceil(input.retryAfterMs / 1000));
  return {
    error: {
      code: "rate_limit_exceeded",
      message: `Agent API key exceeded its ${input.limitType.toUpperCase()} limit.`,
    },
    limitType: input.limitType,
    requestId: input.requestId,
    retryAfterMs: input.retryAfterMs,
    retryAfterSeconds,
  };
}

function budgetFailure(
  code: Exclude<GatewayAgentLimitErrorCode, "rate_limit_exceeded">,
  requestId: string,
): GatewayAgentLimitDecision {
  return {
    body: {
      error: {
        code,
        message: budgetErrorMessage(code),
      },
      requestId,
    },
    ok: false,
    statusCode: 402,
  };
}

function readEnabledGatewayRateLimits(enabledLimits: readonly GatewayEnabledAgentLimit[]): Array<{
  enforcementPolicy: GatewayAgentLimitEnforcementPolicy;
  limitType: GatewayRateLimitType;
  limitValue: number;
  manualBypass: boolean;
}> {
  return enabledLimits
    .filter(
      (limit): limit is GatewayEnabledAgentLimit & { limitType: GatewayRateLimitType } =>
        (limit.limitType === "concurrency" &&
          limit.period === "request" &&
          limit.unit === "requests") ||
        (limit.limitType === "rpm" && limit.period === "minute" && limit.unit === "requests") ||
        (limit.limitType === "tpm" && limit.period === "minute" && limit.unit === "tokens"),
    )
    .sort((a, b) => rateLimitOrder(a.limitType) - rateLimitOrder(b.limitType))
    .map((limit) => ({
      enforcementPolicy: limit.enforcementPolicy,
      limitType: limit.limitType,
      limitValue: limit.limitValue,
      manualBypass: limit.manualBypass,
    }));
}

function readEnabledBudgetLimits(enabledLimits: readonly GatewayEnabledAgentLimit[]): Array<{
  limitType: "budget" | "token";
  limitValue: number;
  period: string;
  unit: string;
}> {
  return enabledLimits
    .filter(
      (limit): limit is GatewayEnabledAgentLimit & { limitType: "budget" | "token" } =>
        limit.limitType === "budget" || limit.limitType === "token",
    )
    .sort((a, b) => budgetPeriodOrder(a.period) - budgetPeriodOrder(b.period))
    .map((limit) => ({
      limitType: limit.limitType,
      limitValue: limit.limitValue,
      period: limit.period,
      unit: limit.unit,
    }));
}

function rateLimitOrder(limitType: GatewayRateLimitType): number {
  return limitType === "concurrency" ? 1 : limitType === "rpm" ? 2 : 3;
}

function budgetPeriodOrder(period: string): number {
  return period === "request"
    ? 0
    : period === "hour"
      ? 1
      : period === "day"
        ? 2
        : period === "week"
          ? 3
          : 4;
}

async function lockRateLimitWindow(
  client: PostgresQueryClient,
  input: {
    agentId: string;
    limitType: GatewayRateLimitType;
    window: WindowBoundary;
  },
): Promise<{ activeCount: number; requestCount: number; tokenCount: number }> {
  await client.query(
    `
      insert into rate_limit_windows (
        id,
        agent_id,
        limit_type,
        window_start,
        window_end
      )
      values ($1, $2, $3, $4, $5)
      on conflict (agent_id, limit_type, window_start) do nothing
    `,
    [
      randomUUID(),
      input.agentId,
      input.limitType,
      input.window.windowStart,
      input.window.windowEnd,
    ],
  );

  const result = await client.query<RateLimitWindowRow>(
    `
      select request_count,
             token_count,
             active_count
      from rate_limit_windows
      where agent_id = $1
        and limit_type = $2
        and window_start = $3
      for update
    `,
    [input.agentId, input.limitType, input.window.windowStart],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Rate limit window was not created.");
  }

  return {
    activeCount: Number(row.active_count),
    requestCount: Number(row.request_count),
    tokenCount: Number(row.token_count),
  };
}

async function incrementRateLimitWindow(
  client: PostgresQueryClient,
  input: {
    agentId: string;
    increment: number;
    limitType: GatewayRateLimitType;
    window: WindowBoundary;
  },
): Promise<void> {
  await client.query(
    `
      update rate_limit_windows
      set request_count = request_count + $1,
          token_count = token_count + $2,
          active_count = active_count + $3,
          updated_at = now()
      where agent_id = $4
        and limit_type = $5
        and window_start = $6
    `,
    [
      input.limitType === "rpm" ? 1 : 0,
      input.limitType === "tpm" ? input.increment : 0,
      input.limitType === "concurrency" ? input.increment : 0,
      input.agentId,
      input.limitType,
      input.window.windowStart,
    ],
  );
}

async function readCurrentBudgetPeriodCost(
  client: PostgresQueryClient,
  input: {
    agentId: string;
    period: WindowBoundary;
    periodType: GatewayBudgetPeriod;
  },
): Promise<number> {
  const result = await client.query<BudgetPeriodCostRow>(
    `
      select cost_used_usd::text
      from budget_periods
      where agent_id = $1
        and period_type = $2
        and period_start = $3
      for update
    `,
    [input.agentId, input.periodType, input.period.windowStart],
  );
  return Number(result.rows[0]?.cost_used_usd ?? 0);
}

function getMinuteWindow(date: Date): WindowBoundary {
  const windowStart = new Date(date);
  windowStart.setUTCSeconds(0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCMinutes(windowEnd.getUTCMinutes() + 1);
  return { windowEnd, windowStart };
}

function getConcurrencyWindow(): WindowBoundary {
  return {
    windowEnd: new Date("9999-12-31T23:59:59.999Z"),
    windowStart: new Date("1970-01-01T00:00:00.000Z"),
  };
}

function getBudgetPeriodWindow(date: Date, period: GatewayBudgetPeriod): WindowBoundary {
  const windowStart = new Date(date);
  windowStart.setUTCMilliseconds(0);
  windowStart.setUTCSeconds(0);
  windowStart.setUTCMinutes(0);

  if (period === "hour") {
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCHours(windowEnd.getUTCHours() + 1);
    return { windowEnd, windowStart };
  }

  windowStart.setUTCHours(0);
  if (period === "day") {
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
    return { windowEnd, windowStart };
  }

  if (period === "week") {
    const day = windowStart.getUTCDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    windowStart.setUTCDate(windowStart.getUTCDate() - daysSinceMonday);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);
    return { windowEnd, windowStart };
  }

  windowStart.setUTCDate(1);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 1);
  return { windowEnd, windowStart };
}

function isBudgetPeriod(period: string): period is GatewayBudgetPeriod {
  return period === "hour" || period === "day" || period === "week" || period === "month";
}

function budgetErrorMessage(code: Exclude<GatewayAgentLimitErrorCode, "rate_limit_exceeded">) {
  if (code === "token_budget_exceeded") {
    return "Agent API key token budget was exceeded.";
  }
  return "Agent API key cost budget was exceeded.";
}
