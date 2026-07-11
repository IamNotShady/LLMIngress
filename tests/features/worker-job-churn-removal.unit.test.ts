import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Worker job churn removal", () => {
  it("registers only the three persistent Provider operations", () => {
    const main = readFileSync("apps/worker/src/main.ts", "utf8");
    const handlers = main.slice(main.indexOf("handlers:"), main.indexOf("leaseMs:"));

    expect(handlers).toContain("model_refresh:");
    expect(handlers).toContain("provider_connectivity_check:");
    expect(handlers).toContain("price_sync:");
    expect(handlers).not.toContain("retention_cleanup");
    expect(handlers).not.toContain("stale_concurrency_reconcile");
  });

  it("replaces scheduled maintenance jobs with direct maintenance", () => {
    expect(existsSync("packages/worker-runtime/src/worker-periodic-scheduler.ts")).toBe(false);
    expect(existsSync("packages/worker-runtime/src/worker-maintenance-scheduler.ts")).toBe(true);

    const scheduler = readFileSync(
      "packages/worker-runtime/src/worker-maintenance-scheduler.ts",
      "utf8",
    );
    expect(scheduler).toContain("pg_try_advisory_lock");
    expect(scheduler).not.toContain("insert into jobs");
    expect(scheduler).not.toContain("job_attempts");
  });

  it("batches retention and honors shutdown cancellation", () => {
    const retention = readFileSync(
      "packages/worker-runtime/src/worker-retention-cleanup.ts",
      "utf8",
    );
    expect(retention).toContain("limit 1000");
    expect(retention).toContain("signal.aborted");
    expect(retention).toContain("provider_health_summary");
    expect(retention).toContain("job_attempts");
  });

  it("limits the final migrated jobs constraint to core job types", () => {
    const migration = readFileSync(
      "packages/db/migrations/0003_remove_budget_reservations.sql",
      "utf8",
    );
    expect(migration).toContain("'model_refresh'");
    expect(migration).toContain("'provider_connectivity_check'");
    expect(migration).toContain("'price_sync'");
    expect(migration).not.toContain("'retention_cleanup'");
    expect(migration).not.toContain("'stale_concurrency_reconcile'");
  });
});
