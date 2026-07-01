import { randomUUID } from "node:crypto";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createStaleReservationCleanupJobHandler } from "@llmingress/db/worker-stale-reservations";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("cleanup releases expired reservations keeps active reservations and reports count", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stale_reservations_${randomUUID().replaceAll("-", "_")}`,
  });
  const jobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seed = await seedBudgetReservations(fixture);
    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        stale_reservation_cleanup: createStaleReservationCleanupJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-14T12:00:00.000Z"),
        }),
      },
      workerId: `worker-stale-reservations-${randomUUID()}`,
    });

    await fixture.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'stale_reservation_cleanup', 'pending', 'scheduled', '{}', 1)
      `,
      [jobId],
    );

    await expect(runner.runOnce()).resolves.toBe(true);

    await expectJobResult(fixture, jobId, {
      releasedReservationCount: 2,
      releasedReservedCostUsd: 0.25,
      releasedReservedTokens: 250,
    });
    await expectReservationStatuses(fixture, {
      [seed.activeReservationId]: "pending",
      [seed.expiredReservationIdA]: "expired",
      [seed.expiredReservationIdB]: "expired",
      [seed.finalizedReservationId]: "finalized",
      [seed.releasedReservationId]: "released",
    });
    await expectBudgetPeriodReservations(fixture, seed.budgetPeriodId, {
      reservedCostUsd: "0.30000000",
      reservedTokens: "300",
    });
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type SeededReservations = {
  activeReservationId: string;
  budgetPeriodId: string;
  expiredReservationIdA: string;
  expiredReservationIdB: string;
  finalizedReservationId: string;
  releasedReservationId: string;
};

type CleanupResult = {
  releasedReservationCount: number;
  releasedReservedCostUsd: number;
  releasedReservedTokens: number;
};

async function seedBudgetReservations(fixture: Fixture): Promise<SeededReservations> {
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const budgetPeriodId = randomUUID();
  const expiredReservationIdA = randomUUID();
  const expiredReservationIdB = randomUUID();
  const activeReservationId = randomUUID();
  const finalizedReservationId = randomUUID();
  const releasedReservationId = randomUUID();

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Stale Budget Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'stale43', key_hash = $3, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, `hash_${randomUUID()}`],
  );
  await fixture.query(
    `
      insert into budget_periods (
        id,
        agent_id,
        period_type,
        period_start,
        period_end,
        reserved_tokens,
        reserved_cost_usd
      )
      values (
        $1,
        $2,
        'month',
        timestamp '2026-06-01T00:00:00Z',
        timestamp '2026-07-01T00:00:00Z',
        550,
        0.55
      )
    `,
    [budgetPeriodId, agentApiKeyId],
  );
  await fixture.query(
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
      values ($1, $2, $3, 'pending', 100, 50, 0.15, timestamp '2026-06-14T11:00:00Z'),
             ($4, $2, $3, 'pending', 75, 25, 0.10, timestamp '2026-06-14T11:59:59Z'),
             ($5, $2, $3, 'pending', 200, 100, 0.30, timestamp '2026-06-14T12:00:01Z'),
             ($6, $2, $3, 'finalized', 10, 10, 0.02, timestamp '2026-06-14T10:00:00Z'),
             ($7, $2, $3, 'released', 20, 20, 0.04, timestamp '2026-06-14T10:00:00Z')
    `,
    [
      expiredReservationIdA,
      agentApiKeyId,
      budgetPeriodId,
      expiredReservationIdB,
      activeReservationId,
      finalizedReservationId,
      releasedReservationId,
    ],
  );

  return {
    activeReservationId,
    budgetPeriodId,
    expiredReservationIdA,
    expiredReservationIdB,
    finalizedReservationId,
    releasedReservationId,
  };
}

async function expectJobResult(
  fixture: Fixture,
  jobId: string,
  expectedResult: CleanupResult,
): Promise<void> {
  const result = await fixture.query<{ result: CleanupResult; status: string }>(
    "select status, result from jobs where id = $1",
    [jobId],
  );

  expect(result.rows[0]).toEqual({
    result: expectedResult,
    status: "succeeded",
  });
}

async function expectReservationStatuses(
  fixture: Fixture,
  expectedStatuses: Record<string, string>,
): Promise<void> {
  const result = await fixture.query<{ id: string; status: string }>(
    `
      select id::text, status
      from budget_reservations
      where id = any($1::uuid[])
      order by id
    `,
    [Object.keys(expectedStatuses)],
  );

  expect(Object.fromEntries(result.rows.map((row) => [row.id, row.status]))).toEqual(
    expectedStatuses,
  );
}

async function expectBudgetPeriodReservations(
  fixture: Fixture,
  budgetPeriodId: string,
  expected: {
    reservedCostUsd: string;
    reservedTokens: string;
  },
): Promise<void> {
  const result = await fixture.query<{
    reserved_cost_usd: string;
    reserved_tokens: string;
  }>(
    `
      select reserved_tokens::text,
             reserved_cost_usd::text
      from budget_periods
      where id = $1
    `,
    [budgetPeriodId],
  );

  expect(result.rows[0]).toEqual({
    reserved_cost_usd: expected.reservedCostUsd,
    reserved_tokens: expected.reservedTokens,
  });
}
