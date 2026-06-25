import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-008 core configuration schema migration", () => {
  it("ships the core configuration schema as the second migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0002");

    expect(migration).toMatchObject({
      id: "0002",
      name: "core_config_schema",
    });
    expect(migration?.sql).toContain("set version = '0002'");
  });

  it("declares the core configuration tables", () => {
    const sql = readCoreConfigMigrationSql();

    expect(sql).toContain("create table if not exists providers");
    expect(sql).toContain("create table if not exists provider_models");
    expect(sql).toContain("create table if not exists agents");
    expect(sql).not.toContain("create table if not exists agent_api_keys");
    expect(sql).toContain("create table if not exists virtual_models");
    expect(sql).toContain("create table if not exists agent_virtual_models");
    expect(sql).toContain("create table if not exists route_policies");
    expect(sql).toContain("create table if not exists route_policy_candidates");
    expect(sql).toContain("create table if not exists agent_limits");
    expect(sql).toContain("create table if not exists config_versions");
    expect(sql).toContain("create table if not exists config_change_events");
  });

  it("declares foreign keys for the core configuration graph", () => {
    const sql = readCoreConfigMigrationSql();

    expect(readCreateTableSql(sql, "provider_models")).toContain(
      "provider_id uuid not null references providers (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "agents")).toContain("key_prefix text unique");
    expect(readCreateTableSql(sql, "agents")).toContain("key_hash text unique");
    expect(readCreateTableSql(sql, "agents")).toContain(
      "default_virtual_model_id uuid references virtual_models (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "route_policies")).toContain(
      "virtual_model_id uuid not null unique references virtual_models (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "route_policy_candidates")).toContain(
      "route_policy_id uuid not null references route_policies (id) on delete cascade",
    );
    expect(readCreateTableSql(sql, "route_policy_candidates")).toContain(
      "provider_model_id uuid not null references provider_models (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "agent_virtual_models")).toContain(
      "agent_id uuid not null references agents (id) on delete cascade",
    );
    expect(readCreateTableSql(sql, "agent_virtual_models")).toContain(
      "virtual_model_id uuid not null references virtual_models (id) on delete restrict",
    );
    expect(readCreateTableSql(sql, "agent_limits")).toContain(
      "agent_id uuid not null references agents (id) on delete cascade",
    );
    expect(readCreateTableSql(sql, "config_change_events")).toContain(
      "config_version_id bigint not null references config_versions (id) on delete cascade",
    );
  });

  it("prevents duplicate route candidates for the same provider model", () => {
    const routeCandidatesSql = readCreateTableSql(
      readCoreConfigMigrationSql(),
      "route_policy_candidates",
    );

    expect(routeCandidatesSql).toContain("unique (route_policy_id, provider_model_id)");
  });
});

function readCoreConfigMigrationSql(): string {
  const migration = loadSqlMigrations().find((candidate) => candidate.id === "0002");
  if (!migration) {
    throw new Error("Missing 0002 core configuration schema migration.");
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
