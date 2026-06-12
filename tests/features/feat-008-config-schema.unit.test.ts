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
    expect(sql).toContain("create table if not exists agent_api_keys");
    expect(sql).toContain("create table if not exists virtual_models");
    expect(sql).toContain("create table if not exists route_policies");
    expect(sql).toContain("create table if not exists route_policy_candidates");
    expect(sql).toContain("create table if not exists agent_limits");
    expect(sql).toContain("create table if not exists config_versions");
    expect(sql).toContain("create table if not exists config_change_events");
  });

  it("declares foreign keys for the core configuration graph", () => {
    const sql = readCoreConfigMigrationSql();

    expect(sql).toMatch(/provider_models[\s\S]+references providers \(id\)/);
    expect(sql).toMatch(/agent_api_keys[\s\S]+references agents \(id\)/);
    expect(sql).toMatch(/agent_api_keys[\s\S]+references virtual_models \(id\)/);
    expect(sql).toMatch(/route_policies[\s\S]+references virtual_models \(id\)/);
    expect(sql).toMatch(/route_policy_candidates[\s\S]+references route_policies \(id\)/);
    expect(sql).toMatch(/route_policy_candidates[\s\S]+references provider_models \(id\)/);
    expect(sql).toMatch(/agent_api_key_virtual_models[\s\S]+references agent_api_keys \(id\)/);
    expect(sql).toMatch(/agent_api_key_virtual_models[\s\S]+references virtual_models \(id\)/);
    expect(sql).toMatch(/agent_limits[\s\S]+references agent_api_keys \(id\)/);
    expect(sql).toMatch(/config_change_events[\s\S]+references config_versions \(id\)/);
  });
});

function readCoreConfigMigrationSql(): string {
  const migration = loadSqlMigrations().find((candidate) => candidate.id === "0002");
  if (!migration) {
    throw new Error("Missing 0002 core configuration schema migration.");
  }
  return migration.sql;
}
