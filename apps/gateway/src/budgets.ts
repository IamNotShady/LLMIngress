import { randomUUID } from "node:crypto";
import { calculateTokenCostUsd, type ModelTokenPrice } from "@llmingress/billing/price-registry";
import { Client, type QueryResultRow } from "pg";
import type { GatewayRequestMetadata } from "./request-metadata.js";

export type GatewayBudgetErrorCode =
  | "cost_budget_exceeded"
  | "cost_budget_price_unavailable"
  | "token_budget_exceeded";

export type GatewayBudgetErrorBody = {
  error: {
    code: GatewayBudgetErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayBudgetPeriod = "day" | "hour" | "month" | "week";

export type GatewayBudgetReservation = {
  budgetPeriodId: string;
  id: string;
  reservedCostUsd: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedTotalTokens: number;
};

export type GatewayBudgetDecision =
  | {
      ok: true;
      reservation?: GatewayBudgetReservation;
    }
  | {
      body: GatewayBudgetErrorBody;
      ok: false;
      statusCode: 402;
    };

type AgentBudgetLimitRow = QueryResultRow & {
  limit_type: "budget" | "token";
  limit_value: string;
  period: string;
  unit: string;
};

type BudgetPeriodRow = QueryResultRow & {
  cost_used_usd: string;
  id: string;
  reserved_cost_usd: string;
};

type PeriodWindow = {
  periodEnd: Date;
  periodStart: Date;
};

export async function reserveGatewayBudget(input: {
  agentApiKeyId: string;
  databaseUrl: string;
  price: ModelTokenPrice;
  requestId: string;
  requestMetadata: GatewayRequestMetadata;
}): Promise<GatewayBudgetDecision> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    const limits = await readEnabledBudgetLimits(client, input.agentApiKeyId);
    const totalTokens =
      input.requestMetadata.estimatedInputTokens + input.requestMetadata.estimatedOutputTokens;

    const tokenLimit = limits.find(
      (limit) =>
        limit.limitType === "token" && limit.period === "request" && limit.unit === "tokens",
    );
    if (tokenLimit && totalTokens > tokenLimit.limitValue) {
      await client.query("rollback");
      return budgetFailure("token_budget_exceeded", input.requestId);
    }

    const costLimit = limits.find(
      (limit) =>
        limit.limitType === "budget" && limit.unit === "usd" && isBudgetPeriod(limit.period),
    );
    if (!costLimit) {
      await client.query("commit");
      return { ok: true };
    }
    if (!isBudgetPeriod(costLimit.period)) {
      await client.query("commit");
      return { ok: true };
    }

    if (input.price.status === "unknown_price") {
      await client.query("rollback");
      return budgetFailure("cost_budget_price_unavailable", input.requestId);
    }

    const reservationInput = calculateBudgetReservation({
      estimatedInputTokens: input.requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: input.requestMetadata.estimatedOutputTokens,
      inputUsdPerMillionTokens: input.price.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: input.price.outputUsdPerMillionTokens,
    });
    const now = new Date();
    const period = getBudgetPeriodWindow(now, costLimit.period);
    const budgetPeriod = await lockBudgetPeriod(client, {
      agentApiKeyId: input.agentApiKeyId,
      period,
      periodType: costLimit.period,
    });

    if (
      Number(budgetPeriod.cost_used_usd) +
        Number(budgetPeriod.reserved_cost_usd) +
        reservationInput.reservedCostUsd >
      costLimit.limitValue
    ) {
      await client.query("rollback");
      return budgetFailure("cost_budget_exceeded", input.requestId);
    }

    const reservation: GatewayBudgetReservation = {
      ...reservationInput,
      budgetPeriodId: budgetPeriod.id,
      id: randomUUID(),
    };
    await client.query(
      `
        update budget_periods
        set reserved_tokens = reserved_tokens + $1,
            reserved_cost_usd = reserved_cost_usd + $2,
            updated_at = now()
        where id = $3
      `,
      [reservation.reservedTotalTokens, reservation.reservedCostUsd, reservation.budgetPeriodId],
    );
    await client.query(
      `
        insert into budget_reservations (
          id,
          agent_id,
          budget_period_id,
          status,
          reserved_input_tokens,
          reserved_output_tokens,
          reserved_cost_usd,
          expires_at
        )
        values ($1, $2, $3, 'pending', $4, $5, $6, now() + interval '5 minutes')
      `,
      [
        reservation.id,
        input.agentApiKeyId,
        reservation.budgetPeriodId,
        reservation.reservedInputTokens,
        reservation.reservedOutputTokens,
        reservation.reservedCostUsd,
      ],
    );

    await client.query("commit");
    return { ok: true, reservation };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function finalizeGatewayBudgetReservation(input: {
  databaseUrl: string;
  reservation: GatewayBudgetReservation | undefined;
}): Promise<void> {
  if (!input.reservation) {
    return;
  }

  await updateGatewayBudgetReservation(input.databaseUrl, input.reservation, "finalized");
}

export async function releaseGatewayBudgetReservation(input: {
  databaseUrl: string;
  reservation: GatewayBudgetReservation | undefined;
}): Promise<void> {
  if (!input.reservation) {
    return;
  }

  await updateGatewayBudgetReservation(input.databaseUrl, input.reservation, "released");
}

export function calculateBudgetReservation(input: {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}): Omit<GatewayBudgetReservation, "budgetPeriodId" | "id"> {
  const cost = calculateTokenCostUsd(
    {
      currency: "USD",
      inputUsdPerMillionTokens: input.inputUsdPerMillionTokens,
      modelId: "budget-estimate",
      outputUsdPerMillionTokens: input.outputUsdPerMillionTokens,
      priceVersion: "budget-estimate",
      providerKey: "budget-estimate",
      snapshotDate: "2026-06-13",
      source: "manual_override",
      sourceUrl: "manual://budget-estimate",
      status: "priced",
      unit: "per_1m_tokens",
    },
    {
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
    },
  );
  if (cost.status !== "estimated") {
    throw new Error("Budget reservation cost estimate failed.");
  }

  return {
    reservedCostUsd: cost.totalCostUsd,
    reservedInputTokens: input.estimatedInputTokens,
    reservedOutputTokens: input.estimatedOutputTokens,
    reservedTotalTokens: input.estimatedInputTokens + input.estimatedOutputTokens,
  };
}

export function getBudgetPeriodWindow(date: Date, period: GatewayBudgetPeriod): PeriodWindow {
  const periodStart = new Date(date);
  periodStart.setUTCMilliseconds(0);
  periodStart.setUTCSeconds(0);
  periodStart.setUTCMinutes(0);

  if (period === "hour") {
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCHours(periodEnd.getUTCHours() + 1);
    return { periodEnd, periodStart };
  }

  periodStart.setUTCHours(0);
  if (period === "day") {
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 1);
    return { periodEnd, periodStart };
  }

  if (period === "week") {
    const day = periodStart.getUTCDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    periodStart.setUTCDate(periodStart.getUTCDate() - daysSinceMonday);
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 7);
    return { periodEnd, periodStart };
  }

  periodStart.setUTCDate(1);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  return { periodEnd, periodStart };
}

export function createGatewayBudgetErrorBody(input: {
  code: GatewayBudgetErrorCode;
  requestId: string;
}): GatewayBudgetErrorBody {
  return {
    error: {
      code: input.code,
      message: budgetErrorMessage(input.code),
    },
    requestId: input.requestId,
  };
}

function budgetFailure(code: GatewayBudgetErrorCode, requestId: string): GatewayBudgetDecision {
  return {
    body: createGatewayBudgetErrorBody({ code, requestId }),
    ok: false,
    statusCode: 402,
  };
}

async function readEnabledBudgetLimits(
  client: Client,
  agentApiKeyId: string,
): Promise<
  Array<{
    limitType: "budget" | "token";
    limitValue: number;
    period: string;
    unit: string;
  }>
> {
  const result = await client.query<AgentBudgetLimitRow>(
    `
      select limit_type,
             period,
             limit_value::text,
             unit
      from agent_limits
      where agent_id = $1
        and enabled = true
        and limit_type in ('budget', 'token')
      order by case period
        when 'request' then 0
        when 'hour' then 1
        when 'day' then 2
        when 'week' then 3
        else 4
      end
    `,
    [agentApiKeyId],
  );

  return result.rows.map((row) => ({
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    period: row.period,
    unit: row.unit,
  }));
}

async function lockBudgetPeriod(
  client: Client,
  input: {
    agentApiKeyId: string;
    period: PeriodWindow;
    periodType: GatewayBudgetPeriod;
  },
): Promise<BudgetPeriodRow> {
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
      input.agentApiKeyId,
      input.periodType,
      input.period.periodStart,
      input.period.periodEnd,
    ],
  );

  const result = await client.query<BudgetPeriodRow>(
    `
      select id::text,
             cost_used_usd::text,
             reserved_cost_usd::text
      from budget_periods
      where agent_id = $1
        and period_type = $2
        and period_start = $3
      for update
    `,
    [input.agentApiKeyId, input.periodType, input.period.periodStart],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Budget period was not created.");
  }
  return row;
}

async function updateGatewayBudgetReservation(
  databaseUrl: string,
  reservation: GatewayBudgetReservation,
  status: "finalized" | "released",
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    const result = await client.query<{ status: string }>(
      "select status from budget_reservations where id = $1 for update",
      [reservation.id],
    );
    if (result.rows[0]?.status !== "pending") {
      await client.query("commit");
      return;
    }

    if (status === "finalized") {
      await client.query(
        `
          update budget_periods
          set tokens_used = tokens_used + $1,
              cost_used_usd = cost_used_usd + $2,
              reserved_tokens = greatest(reserved_tokens - $1, 0),
              reserved_cost_usd = greatest(reserved_cost_usd - $2, 0),
              updated_at = now()
          where id = $3
        `,
        [reservation.reservedTotalTokens, reservation.reservedCostUsd, reservation.budgetPeriodId],
      );
      await client.query(
        `
          update budget_reservations
          set status = 'finalized',
              actual_total_tokens = $1,
              actual_cost_usd = $2,
              finalized_at = now(),
              updated_at = now()
          where id = $3
        `,
        [reservation.reservedTotalTokens, reservation.reservedCostUsd, reservation.id],
      );
    } else {
      await client.query(
        `
          update budget_periods
          set reserved_tokens = greatest(reserved_tokens - $1, 0),
              reserved_cost_usd = greatest(reserved_cost_usd - $2, 0),
              updated_at = now()
          where id = $3
        `,
        [reservation.reservedTotalTokens, reservation.reservedCostUsd, reservation.budgetPeriodId],
      );
      await client.query(
        `
          update budget_reservations
          set status = 'released',
              updated_at = now()
          where id = $1
        `,
        [reservation.id],
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function isBudgetPeriod(period: string): period is GatewayBudgetPeriod {
  return period === "hour" || period === "day" || period === "week" || period === "month";
}

function budgetErrorMessage(code: GatewayBudgetErrorCode): string {
  if (code === "token_budget_exceeded") {
    return "Agent API key token budget was exceeded.";
  }
  if (code === "cost_budget_price_unavailable") {
    return "Cost budget enforcement requires a known model price.";
  }
  return "Agent API key cost budget was exceeded.";
}
