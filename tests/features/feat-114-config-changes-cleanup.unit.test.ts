import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(import.meta.dirname, "../..");

describe("feat-114 config change cleanup", () => {
  it("declares a migration that moves config_change_events into config_versions.changes", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0040" && candidate.name === "merge_config_changes_into_versions",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("alter table config_versions");
    expect(sql).toContain("changes jsonb not null default '[]'::jsonb");
    expect(sql).toContain("jsonb_agg");
    expect(sql).toContain("from config_change_events");
    expect(sql).toContain("drop table if exists config_change_events");
    expect(sql).not.toContain("insert into schema_version");
  });

  it("removes config_change_events publisher writes and backup coverage", () => {
    const publisherSource = readFileSync(
      resolve(root, "packages/db/src/config-versions.ts"),
      "utf8",
    );
    const backupSource = readFileSync(resolve(root, "apps/worker/src/backup.ts"), "utf8");

    expect(publisherSource).toContain(
      "insert into config_versions (version, source, description, changes)",
    );
    expect(publisherSource).not.toContain("insert into config_change_events");
    expect(backupSource).not.toContain('"config_change_events"');
  });
});
