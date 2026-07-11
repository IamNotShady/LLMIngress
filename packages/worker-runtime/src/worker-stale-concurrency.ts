import { getPostgresPool } from "@llmingress/db/client";

export type StaleConcurrencyReconcileResult = {
  reconciledWindowCount: number;
};

export async function reconcileGatewayConcurrencyWindows(
  input: { databaseUrl?: string; inFlightMaxAgeMinutes?: number; quietMinutes?: number } = {},
): Promise<StaleConcurrencyReconcileResult> {
  const inFlightMaxAgeMinutes = input.inFlightMaxAgeMinutes ?? 15;
  const quietMinutes = input.quietMinutes ?? 5;
  const result = await getPostgresPool(input.databaseUrl).query(
    `
      update rate_limit_windows as w
      set active_count = live.active_count,
          updated_at = now()
      from (
        select w2.id,
               (
                 select count(*)::int
                 from request_activity as ra
                 where ra.agent_id = w2.agent_id
                   and ra.status = 'started'
                   and ra.started_at > now() - make_interval(mins => $1::int)
               ) as active_count
        from rate_limit_windows as w2
        where w2.limit_type = 'concurrency'
          and w2.updated_at < now() - make_interval(mins => $2::int)
      ) as live
      where w.id = live.id
        and w.active_count <> live.active_count
    `,
    [inFlightMaxAgeMinutes, quietMinutes],
  );
  return { reconciledWindowCount: result.rowCount ?? 0 };
}
