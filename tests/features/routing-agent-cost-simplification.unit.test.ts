import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("routing, Agent, and cost simplification", () => {
  it("removes standalone routing and preview surfaces", () => {
    for (const path of [
      "apps/console/src/app/(dashboard)/routing/page.tsx",
      "apps/console/src/app/_modules/route-policies-section.tsx",
      "apps/console/src/app/api/route-policies/preview/route.ts",
      "packages/db/src/console-route-preview.ts",
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
    const dbPackage = JSON.parse(readFileSync("packages/db/package.json", "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(dbPackage.exports["./console-route-preview"]).toBeUndefined();
  });

  it("keeps only core route policy behavior", () => {
    expect(searchProduction("quality_first")).toBe("");
    for (const field of ["taskTypes", "requiredCapabilities", "requireTools", "retryAttempts"]) {
      expect(searchProduction(field), field).toBe("");
    }
    const source = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(source).toContain('"fixed"');
    expect(source).toContain('"cost_first"');
    expect(source).toContain('"random"');
  });

  it("removes Agent type and request logging switches from application code", () => {
    expect(searchProduction("\\bagentType\\b")).toBe("");
    expect(searchProduction("\\brequestLoggingEnabled\\b")).toBe("");
    expect(searchProduction("request_logging_enabled")).toBe("");
  });

  it("records actual request cost without baseline or savings calculations", () => {
    for (const value of [
      "baselineCost",
      "baselinePrice",
      "baselineProviderModelId",
      "savingsPercent",
      "savingsUsd",
      "totalSavingsUsd",
    ]) {
      expect(searchProduction(value), value).toBe("");
    }
    const recorder = readFileSync("packages/gateway-runtime/src/gateway-usage-recorder.ts", "utf8");
    expect(recorder).toContain("total_cost_usd");
  });

  it("stores endpoint protocol explicitly and removes retired database columns", () => {
    const baseline = readFileSync("packages/db/migrations/0001_v1_baseline.sql", "utf8");
    expect(baseline).toContain("endpoint_protocol text NOT NULL");
    expect(baseline).not.toContain("route_policies_rules_object_check");
    for (const column of [
      "agent_type",
      "request_logging_enabled",
      "baseline_provider_model_id",
      "baseline_cost_usd",
      "savings_usd",
      "savings_percent",
      "reconciled_at",
    ]) {
      expect(baseline, column).not.toContain(column);
    }
  });
});

function searchProduction(pattern: string): string {
  try {
    return execFileSync("rg", ["-n", pattern, "apps", "packages", "-g", "*.ts", "-g", "*.tsx"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return "";
    }
    throw error;
  }
}
