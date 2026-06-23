import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { shippedSqlMigrations } from "../../packages/db/src/migration-status";

describe("feat-117 strategy fallback chain", () => {
  describe("migration 0048", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0048" &&
        candidate.name === "remove_route_policy_candidate_fallback",
    );

    it("ships the 0048 remove_route_policy_candidate_fallback migration", () => {
      expect(migration, "missing 0048_remove_route_policy_candidate_fallback migration").toBeDefined();
    });

    it("0048 SQL drops the is_fallback column", () => {
      expect(migration).toBeDefined();
      const sql = (migration?.sql ?? "").toLowerCase();
      expect(sql).toContain("drop column");
      expect(sql).toContain("is_fallback");
    });

    it("0048 SQL re-sequences candidate_order using row_number() over route_policy_id", () => {
      expect(migration).toBeDefined();
      const sql = (migration?.sql ?? "").toLowerCase();
      expect(sql).toContain("row_number()");
      expect(sql).toContain("route_policy_id");
    });

    it("shippedSqlMigrations contains a 0048 entry whose checksum matches the loaded SQL", () => {
      expect(migration).toBeDefined();
      expect(shippedSqlMigrations.find((entry) => entry.id === "0048")).toEqual({
        checksum: migration?.checksum,
        id: "0048",
        name: "remove_route_policy_candidate_fallback",
      });
    });
  });
});
