import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/maintenance";
import type { JobHandler } from "./worker-job-runner.ts";

export type ExpiredBudgetReservationRelease = {
  reservedCostUsd: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
};

export type StaleReservationCleanupResult = {
  releasedReservationCount: number;
  releasedReservedCostUsd: number;
  releasedReservedTokens: number;
};

type CreateStaleReservationCleanupJobHandlerOptions = {
  databaseUrl: string;
  now?: () => Date;
};

type CleanupStaleBudgetReservationsOptions = CreateStaleReservationCleanupJobHandlerOptions;

type CleanupResultRow = PostgresQueryResultRow & {
  released_reservation_count: number;
  released_reserved_cost_usd: string;
  released_reserved_tokens: string;
};

export function createStaleReservationCleanupJobHandler(
  options: CreateStaleReservationCleanupJobHandlerOptions,
): JobHandler {
  return async () => cleanupStaleBudgetReservations(options);
}

export async function cleanupStaleBudgetReservations(
  options: CleanupStaleBudgetReservationsOptions,
): Promise<StaleReservationCleanupResult> {
  const client = new PostgresClient({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    const result = await client.query<CleanupResultRow>(
      `
        with expired_reservations as (
          select id,
                 budget_period_id,
                 reserved_input_tokens::bigint + reserved_output_tokens::bigint as reserved_tokens,
                 reserved_cost_usd
          from budget_reservations
          where status = 'pending'
            and expires_at <= $1::timestamptz
          for update skip locked
        ),
        period_releases as (
          select budget_period_id,
                 sum(reserved_tokens)::bigint as reserved_tokens,
                 sum(reserved_cost_usd)::numeric(20, 8) as reserved_cost_usd
          from expired_reservations
          where budget_period_id is not null
          group by budget_period_id
        ),
        updated_periods as (
          update budget_periods
          set reserved_tokens = greatest(
                budget_periods.reserved_tokens - period_releases.reserved_tokens,
                0::bigint
              ),
              reserved_cost_usd = greatest(
                budget_periods.reserved_cost_usd - period_releases.reserved_cost_usd,
                0::numeric
              ),
              updated_at = $1::timestamptz
          from period_releases
          where budget_periods.id = period_releases.budget_period_id
          returning period_releases.reserved_tokens, period_releases.reserved_cost_usd
        ),
        updated_reservations as (
          update budget_reservations
          set status = 'expired',
              updated_at = $1::timestamptz
          from expired_reservations
          where budget_reservations.id = expired_reservations.id
          returning budget_reservations.id
        )
        select count(updated_reservations.id)::integer as released_reservation_count,
               coalesce((select sum(reserved_tokens) from updated_periods), 0)::text
                 as released_reserved_tokens,
               coalesce((select sum(reserved_cost_usd) from updated_periods), 0)::text
                 as released_reserved_cost_usd
        from updated_reservations
      `,
      [(options.now?.() ?? new Date()).toISOString()],
    );
    await client.query("commit");
    return cleanupRowToResult(result.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function summarizeExpiredBudgetReservationRelease(
  reservations: ExpiredBudgetReservationRelease[],
): StaleReservationCleanupResult {
  return {
    releasedReservationCount: reservations.length,
    releasedReservedCostUsd: roundUsd(
      reservations.reduce((sum, reservation) => sum + reservation.reservedCostUsd, 0),
    ),
    releasedReservedTokens: reservations.reduce(
      (sum, reservation) =>
        sum + reservation.reservedInputTokens + reservation.reservedOutputTokens,
      0,
    ),
  };
}

function cleanupRowToResult(row: CleanupResultRow | undefined): StaleReservationCleanupResult {
  if (!row) {
    return {
      releasedReservationCount: 0,
      releasedReservedCostUsd: 0,
      releasedReservedTokens: 0,
    };
  }

  return {
    releasedReservationCount: row.released_reservation_count,
    releasedReservedCostUsd: Number(row.released_reserved_cost_usd),
    releasedReservedTokens: Number(row.released_reserved_tokens),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
