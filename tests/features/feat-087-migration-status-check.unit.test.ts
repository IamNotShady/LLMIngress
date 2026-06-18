import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
import {
  formatMigrationStatusReport,
  type MigrationStatusMigration,
  shippedSqlMigrations,
  summarizeMigrationStatus,
} from "../../packages/db/src/migration-status";

const root = resolve(import.meta.dirname, "../..");

describe("feat-087 migration status check", () => {
  it("adds a migration status CLI script", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

    expect(packageJson.scripts["db:migrate:status"]).toBe(
      "tsx scripts/run-with-env.ts tsx scripts/migration-status.ts",
    );
    expect(existsSync(resolve(root, "scripts/migration-status.ts"))).toBe(true);
  });

  it("keeps the Console migration manifest aligned with SQL migrations", () => {
    expect(shippedSqlMigrations).toEqual(
      loadSqlMigrations().map(({ checksum, id, name }) => ({
        checksum,
        id,
        name,
      })),
    );
  });

  it("summarizes current schema pending migrations and migrate check health", () => {
    const migrations = [
      testMigration("0001", "create_schema_version", "checksum-0001"),
      testMigration("0002", "core_config_schema", "checksum-0002"),
      testMigration("0003", "runtime_records_jobs_schema", "checksum-0003"),
    ];

    const status = summarizeMigrationStatus({
      appliedMigrations: [
        {
          appliedAt: new Date("2026-06-16T00:00:00.000Z"),
          checksum: "checksum-0001",
          id: "0001",
          name: "create_schema_version",
        },
        {
          appliedAt: new Date("2026-06-16T00:01:00.000Z"),
          checksum: "checksum-0002",
          id: "0002",
          name: "core_config_schema",
        },
      ],
      currentSchemaVersion: "0002",
      migrations,
    });

    expect(status).toMatchObject({
      appliedCount: 2,
      currentSchemaVersion: "0002",
      latestMigrationId: "0003",
      pendingCount: 1,
      status: "pending",
      totalCount: 3,
    });
    expect(status.pendingMigrations.map((migration) => migration.id)).toEqual(["0003"]);
    expect(status.migrateCheckHealth).toEqual({
      command: "pnpm run db:migrate:check",
      message: "Migration validation can run; pending migrations remain.",
      status: "ready",
    });
    expect(formatMigrationStatusReport(status)).toContain("Current schema: 0002");
    expect(formatMigrationStatusReport(status)).toContain(
      "Pending migrations: 0003_runtime_records_jobs_schema",
    );
    expect(formatMigrationStatusReport(status)).toContain(
      "db:migrate:check health: Ready - Migration validation can run; pending migrations remain.",
    );
  });

  it("marks checksum mismatches as blocked migrate check health", () => {
    const status = summarizeMigrationStatus({
      appliedMigrations: [
        {
          appliedAt: new Date("2026-06-16T00:00:00.000Z"),
          checksum: "old-checksum",
          id: "0001",
          name: "create_schema_version",
        },
      ],
      currentSchemaVersion: "0001",
      migrations: [testMigration("0001", "create_schema_version", "new-checksum")],
    });

    expect(status).toMatchObject({
      checksumMismatches: [
        {
          appliedChecksum: "old-checksum",
          expectedChecksum: "new-checksum",
          id: "0001",
        },
      ],
      status: "mismatch",
    });
    expect(status.migrateCheckHealth).toEqual({
      command: "pnpm run db:migrate:check",
      message: "Migration validation is blocked by checksum mismatch.",
      status: "blocked",
    });
  });
});

function testMigration(id: string, name: string, checksum: string): MigrationStatusMigration {
  return {
    checksum,
    id,
    name,
  };
}
