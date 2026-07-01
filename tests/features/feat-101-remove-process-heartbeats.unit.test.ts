import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { shippedSqlMigrations } from "../../packages/db/src/migration-status";

const root = resolve(import.meta.dirname, "../..");

describe("feat-101 remove process heartbeats table", () => {
  it("ships a current-schema cleanup migration and migration-status manifest entry", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0025" && candidate.name === "remove_process_heartbeats",
    );

    expect(migration, "missing 0025_remove_process_heartbeats migration").toBeDefined();
    if (!migration) {
      return;
    }

    expect(migration.sql).toContain(
      "drop index if exists idx_process_heartbeats_type_heartbeat_at",
    );
    expect(migration.sql).toContain("drop table if exists process_heartbeats");
    expect(migration.sql).toContain("set version = '0025'");
    expect(shippedSqlMigrations.find((entry) => entry.id === "0025")).toEqual({
      checksum: migration.checksum,
      id: "0025",
      name: "remove_process_heartbeats",
    });
  });

  it("removes process_heartbeats from backup and current runtime contracts", () => {
    const backupSource = readFileSync(resolve(root, "packages/db/src/worker-backup.ts"), "utf8");
    const feat009UnitSource = readFileSync(
      resolve(root, "tests/features/feat-009-runtime-schema.unit.test.ts"),
      "utf8",
    );
    const architectureSource = readFileSync(resolve(root, "docs/ARCHITECTURE.md"), "utf8");

    expect(backupSource).not.toContain('"process_heartbeats"');
    expect(feat009UnitSource).not.toContain('"process_heartbeats"');
    expect(architectureSource).not.toContain("process_heartbeats");
  });
});
