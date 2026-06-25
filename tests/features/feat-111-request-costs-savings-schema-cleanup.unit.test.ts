import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(import.meta.dirname, "../..");

describe("feat-111 request costs savings schema cleanup", () => {
  it("adds savings fields to request_costs and drops obsolete schema tables", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0037" && candidate.name === "merge_request_savings_and_schema_version",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("alter table request_costs");
    expect(sql).toContain("baseline_provider_model_id uuid references provider_models");
    expect(sql).toContain("actual_cost_usd numeric(20, 8)");
    expect(sql).toContain("baseline_cost_usd numeric(20, 8)");
    expect(sql).toContain("savings_usd numeric(20, 8)");
    expect(sql).toContain("savings_percent numeric(12, 6)");
    expect(sql).toContain("savings_price_source text");
    expect(sql).toContain("savings_price_version text");
    expect(sql).toContain("from request_savings");
    expect(sql).toContain("drop table if exists request_savings");
    expect(sql).toContain("drop table if exists schema_version");
    expect(sql).not.toContain("insert into schema_version");
  });

  it("removes request_savings production reads and writes", () => {
    const files = [
      "apps/gateway/src/usage-recorder.ts",
      "apps/console/src/server/analytics.ts",
      "apps/console/src/server/usage.ts",
      "apps/worker/src/billing-reconciliation.ts",
      "apps/worker/src/cost-report-export.ts",
      "apps/worker/src/backup.ts",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");

      expect(source, file).not.toContain("insert into request_savings");
      expect(source, file).not.toContain("update request_savings");
      expect(source, file).not.toContain("from request_savings");
      expect(source, file).not.toContain("join request_savings");
      expect(source, file).not.toContain('"request_savings"');
    }
  });

  it("uses migration_history instead of schema_version for current migration status", () => {
    for (const file of ["packages/db/src/index.ts", "packages/db/src/migration-status.ts"]) {
      const source = readFileSync(resolve(root, file), "utf8");

      expect(source, file).not.toContain('tableExists(client, "schema_version")');
      expect(source, file).not.toContain("from schema_version");
      expect(source, file).toContain("migration_history");
    }
  });
});
