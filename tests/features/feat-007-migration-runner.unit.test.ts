import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-007 PostgreSQL migration runner", () => {
  it("loads SQL migrations in id order with stable checksums", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llmingress-migrations-"));

    try {
      writeFileSync(join(tempDir, "0002_second.sql"), "select 2;\n", "utf8");
      writeFileSync(join(tempDir, "0001_first.sql"), "select 1;\n", "utf8");

      const migrations = loadSqlMigrations({ migrationsDirectory: tempDir });

      expect(migrations.map((migration) => migration.id)).toEqual(["0001", "0002"]);
      expect(migrations.map((migration) => migration.name)).toEqual(["first", "second"]);
      expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate migration ids before applying anything", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llmingress-migrations-"));

    try {
      writeFileSync(join(tempDir, "0001_first.sql"), "select 1;\n", "utf8");
      writeFileSync(join(tempDir, "0001_duplicate.sql"), "select 2;\n", "utf8");

      expect(() => loadSqlMigrations({ migrationsDirectory: tempDir })).toThrow(/0001/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ships an initial schema version migration", () => {
    const migrations = loadSqlMigrations();

    expect(migrations[0]).toMatchObject({
      id: "0001",
      name: "create_schema_version",
    });
    expect(migrations[0]?.sql).toContain("schema_version");
    expect(migrations[0]?.sql).toContain("migration_history");
  });
});
