import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-009 runtime records and jobs schema migration", () => {
  it("ships the runtime records and jobs schema as the third migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0003");

    expect(migration).toMatchObject({
      id: "0003",
      name: "runtime_records_jobs_schema",
    });
    expect(migration?.sql).toContain("set version = '0003'");
  });

  it("declares runtime, budget, job, health, and status tables", () => {
    const sql = readRuntimeSchemaMigrationSql();

    for (const tableName of [
      "rate_limit_windows",
      "budget_periods",
      "budget_reservations",
      "request_activity",
      "request_usage",
      "request_costs",
      "request_savings",
      "fallback_events",
      "jobs",
      "job_attempts",
      "provider_health_events",
      "provider_health_summary",
      "gateway_runtime_status",
      "process_heartbeats",
      "runtime_errors",
    ]) {
      expect(sql).toContain(`create table if not exists ${tableName}`);
    }
  });

  it("declares foreign keys that preserve runtime attribution", () => {
    const sql = readRuntimeSchemaMigrationSql();

    expect(readCreateTableSql(sql, "request_activity")).toContain(
      "agent_api_key_id uuid not null references agent_api_keys (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "request_activity")).toContain(
      "provider_model_id uuid references provider_models (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "request_usage")).toContain(
      "request_activity_id uuid not null unique references request_activity (id) on delete cascade",
    );
    expect(readCreateTableSql(sql, "budget_reservations")).toContain(
      "budget_period_id uuid references budget_periods (id) on delete cascade",
    );
    expect(readCreateTableSql(sql, "job_attempts")).toContain(
      "job_id uuid not null references jobs (id) on delete cascade",
    );
    expect(readCreateTableSql(sql, "provider_health_events")).toContain(
      "job_id uuid references jobs (id) on delete set null",
    );
    expect(readCreateTableSql(sql, "gateway_runtime_status")).toContain(
      "applied_config_version integer references config_versions (version) on delete restrict",
    );
  });

  it("declares review-required invariants for provider attribution health summaries and job leases", () => {
    const sql = readRuntimeSchemaMigrationSql();

    expect(readCreateTableSql(sql, "budget_periods")).toContain(
      "tokens_used bigint not null default 0 check (tokens_used >= 0)",
    );
    expect(readCreateTableSql(sql, "budget_periods")).toContain(
      "reserved_tokens bigint not null default 0 check (reserved_tokens >= 0)",
    );
    expect(readCreateTableSql(sql, "jobs")).toContain(
      "check ((lease_owner is null) = (lease_expires_at is null))",
    );
    expect(sql).toContain("request_activity_provider_model_provider_match");
    expect(sql).toContain("provider_health_events_model_provider_match");
    expect(sql).toContain("provider_health_summary_model_provider_match");
    expect(sql).toContain("create unique index if not exists uq_provider_health_summary_provider");
    expect(sql).toContain("where provider_model_id is null");
    expect(sql).toContain(
      "create unique index if not exists uq_provider_health_summary_provider_model",
    );
    expect(sql).toContain("where provider_model_id is not null");
  });

  it("declares indexes for runtime list, reservation cleanup, job claiming, and health lookups", () => {
    const sql = readRuntimeSchemaMigrationSql();

    for (const indexName of [
      "idx_request_activity_agent_created_at",
      "idx_request_activity_virtual_model_created_at",
      "idx_request_usage_agent_created_at",
      "idx_budget_reservations_pending_expires_at",
      "idx_jobs_pending_run_after",
      "idx_jobs_running_lease_expires_at",
      "idx_provider_health_events_provider_observed_at",
      "idx_provider_health_events_model_observed_at",
      "idx_gateway_runtime_status_heartbeat_at",
      "idx_runtime_errors_process_created_at",
    ]) {
      expect(sql).toContain(`create index if not exists ${indexName}`);
    }
  });
});

function readRuntimeSchemaMigrationSql(): string {
  const migration = loadSqlMigrations().find((candidate) => candidate.id === "0003");
  if (!migration) {
    throw new Error("Missing 0003 runtime records and jobs schema migration.");
  }
  return migration.sql;
}

function readCreateTableSql(sql: string, tableName: string): string {
  const match = new RegExp(`create table if not exists ${tableName} \\([\\s\\S]*?\\n\\);`).exec(
    sql,
  );
  if (!match?.[0]) {
    throw new Error(`Missing create table block for ${tableName}.`);
  }
  return match[0];
}
