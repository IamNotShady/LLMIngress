import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const milestoneIds = [
  "core-platform-security",
  "provider-model-management",
  "virtual-model-routing",
  "gateway-protocol-execution",
  "agent-access-and-limits",
  "usage-and-activity",
  "worker-model-operations",
  "console-core",
  "release-guards",
];

describe("release schema baseline", () => {
  it("ships one pre-release core migration", () => {
    expect(readdirSync("packages/db/migrations").filter((name) => name.endsWith(".sql"))).toEqual([
      "0001_core_baseline.sql",
    ]);
  });

  it("removes non-core schema and job vocabulary", () => {
    const baseline = readFileSync("packages/db/migrations/0001_core_baseline.sql", "utf8");
    for (const table of [
      "notification_channels",
      "notification_events",
      "webhook_deliveries",
      "gateway_runtime_status",
      "runtime_errors",
    ]) {
      expect(baseline, table).not.toContain(table);
    }
    for (const jobType of [
      "retention_cleanup",
      "stale_concurrency_reconcile",
      "backup",
      "jsonl_export",
      "cost_report_export",
      "webhook_export",
      "billing_reconciliation",
    ]) {
      expect(baseline, jobType).not.toContain(jobType);
    }
  });

  it("tracks nine current release domains", () => {
    const tracker = JSON.parse(readFileSync("feature_list.json", "utf8")) as {
      features: Array<{ id: string; status: string }>;
    };
    expect(tracker.features.map(({ id }) => id)).toEqual(milestoneIds);
    expect(tracker.features.every(({ status }) => status === "passing")).toBe(true);

    const progress = readFileSync("progress.md", "utf8");
    expect(progress.split(/\r?\n/).length).toBeLessThanOrEqual(40);
    expect(progress).not.toContain("High Priority Hardening 9");
  });

  it("guards deleted product surfaces from returning", () => {
    const releaseGuard = readFileSync(
      "tests/features/repository-release-guards.unit.case.ts",
      "utf8",
    );
    for (const retired of [
      "notification_channels",
      "gateway_runtime_status",
      "runtime_errors",
      "quality_first",
      "request_logging_enabled",
      "billing_reconciliation",
    ]) {
      expect(releaseGuard, retired).toContain(retired);
    }
  });
});
