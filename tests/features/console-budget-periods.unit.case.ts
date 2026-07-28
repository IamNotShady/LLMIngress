import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listConsoleCurrentBudgetPeriods } from "../../packages/db/src/console-api-key-limits.ts";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index.ts";

describe("console current budget periods", () => {
  it("returns the period covering now, not the newest row", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_budget_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const apiKeyId = randomUUID();
      const now = new Date("2026-07-25T12:00:00.000Z");
      await fixture.query(
        "insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'cursor-agent', 'llmi_a…', gen_random_uuid()::text)",
        [apiKeyId],
      );
      await fixture.query(
        `insert into budget_periods (id, api_key_id, period_type, period_start, period_end, cost_used_usd, tokens_used) values
           (gen_random_uuid(), $1, 'month', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', 41.5, 900),
           (gen_random_uuid(), $1, 'month', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 13.87, 1200),
           (gen_random_uuid(), $1, 'month', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 0, 0)`,
        [apiKeyId],
      );

      const periods = await listConsoleCurrentBudgetPeriods({
        databaseUrl: fixture.databaseUrl,
        now,
      });
      const period = periods.find((entry) => entry.apiKeyId === apiKeyId);

      // A future period row exists; SPENT must come from the window we are in.
      expect(period?.costUsedUsd).toBe("13.87000000");
      expect(period?.periodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(period?.tokensUsed).toBe(1200);
    } finally {
      await fixture.dispose();
    }
  });

  it("measures spend against the window the key's own rule defines", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_budget_rule_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const apiKeyId = randomUUID();
      const now = new Date("2026-07-25T12:00:00.000Z");
      await fixture.query(
        "insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'docs-bot', 'llmi_d…', gen_random_uuid()::text)",
        [apiKeyId],
      );
      // The key moved from a monthly budget to a daily one; the monthly rows
      // are still there and still cover today.
      await fixture.query(
        `insert into api_key_limits (id, api_key_id, limit_type, limit_value, unit, period, enabled)
         values (gen_random_uuid(), $1, 'budget', 5, 'usd', 'day', true)`,
        [apiKeyId],
      );
      await fixture.query(
        `insert into budget_periods (id, api_key_id, period_type, period_start, period_end, cost_used_usd, tokens_used) values
           (gen_random_uuid(), $1, 'month', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 88.20, 500000),
           (gen_random_uuid(), $1, 'day', '2026-07-25T00:00:00Z', '2026-07-26T00:00:00Z', 1.40, 9000)`,
        [apiKeyId],
      );

      const periods = await listConsoleCurrentBudgetPeriods({
        databaseUrl: fixture.databaseUrl,
        now,
      });
      const period = periods.find((entry) => entry.apiKeyId === apiKeyId);

      // The daily rule is what enforces, so the daily window is what SPENT
      // means — the stale monthly row must not stand in for it.
      expect(period?.periodType).toBe("day");
      expect(period?.costUsedUsd).toBe("1.40000000");
      expect(period?.tokensUsed).toBe(9000);
    } finally {
      await fixture.dispose();
    }
  });

  it("returns nothing for a key whose periods have all elapsed", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_budget_none_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const apiKeyId = randomUUID();
      await fixture.query(
        "insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'ci-runner', 'llmi_c…', gen_random_uuid()::text)",
        [apiKeyId],
      );
      await fixture.query(
        `insert into budget_periods (id, api_key_id, period_type, period_start, period_end, cost_used_usd)
         values (gen_random_uuid(), $1, 'day', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 3)`,
        [apiKeyId],
      );

      const periods = await listConsoleCurrentBudgetPeriods({
        databaseUrl: fixture.databaseUrl,
        now: new Date("2026-07-25T12:00:00.000Z"),
      });

      expect(periods).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
