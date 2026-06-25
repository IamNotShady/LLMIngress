import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(import.meta.dirname, "../..");

describe("feat-113 export task cleanup", () => {
  it("declares a migration that moves export_tasks into jobs.result and drops the table", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0039" && candidate.name === "merge_export_tasks_into_jobs",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("from export_tasks");
    expect(sql).toContain("job_id is null");
    expect(sql).toContain("raise exception");
    expect(sql).toContain("update jobs");
    expect(sql).toContain("drop table if exists export_tasks");
    expect(sql).not.toContain("insert into schema_version");
  });

  it("removes export_tasks production reads writes and backup coverage", () => {
    const files = [
      "apps/worker/src/jsonl-export.ts",
      "apps/worker/src/cost-report-export.ts",
      "apps/worker/src/retention-cleanup.ts",
      "apps/worker/src/backup.ts",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");

      expect(source, file).not.toContain("insert into export_tasks");
      expect(source, file).not.toContain("from export_tasks");
      expect(source, file).not.toContain("delete from export_tasks");
      expect(source, file).not.toContain('"export_tasks"');
    }
  });
});
