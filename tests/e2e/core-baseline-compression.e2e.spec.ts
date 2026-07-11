import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

const expectedTables = [
  "agent_limits",
  "agent_virtual_models",
  "agents",
  "budget_periods",
  "config_versions",
  "console_admins",
  "console_sessions",
  "fallback_events",
  "job_attempts",
  "jobs",
  "migration_history",
  "provider_api_keys",
  "provider_health_events",
  "provider_health_summary",
  "provider_models",
  "provider_oauth",
  "providers",
  "rate_limit_windows",
  "request_activity",
  "request_costs",
  "request_usage",
  "route_policies",
  "route_policy_candidates",
  "virtual_models",
];

test("fresh migration creates only the 24 core tables", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_core_baseline_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    const result = await runMigrations({ databaseUrl: fixture.databaseUrl });
    expect(result.applied.map(({ filename }) => filename)).toEqual(["0001_core_baseline.sql"]);

    const tables = await fixture.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
      order by table_name
    `);
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual(expectedTables);

    const jobTypes = await fixture.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'jobs'::regclass
        and conname = 'jobs_job_type_check'
    `);
    expect(jobTypes.rows[0]?.definition).toContain("model_refresh");
    expect(jobTypes.rows[0]?.definition).toContain("provider_connectivity_check");
    expect(jobTypes.rows[0]?.definition).toContain("price_sync");
    expect(jobTypes.rows[0]?.definition).not.toContain("retention_cleanup");
  } finally {
    await fixture.dispose();
  }
});
