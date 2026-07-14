import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
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

const retiredPaths = [
  "apps/console/src/app/(dashboard)/routing/page.tsx",
  "apps/console/src/app/(dashboard)/runtime/page.tsx",
  "apps/console/src/app/(dashboard)/settings/page.tsx",
  "apps/console/src/app/api/notifications/route.ts",
  "apps/console/src/app/api/route-policies/preview/route.ts",
  "packages/db/src/console-notification-channels.ts",
  "packages/worker-runtime/src/worker-alerts.ts",
  "packages/worker-runtime/src/worker-backup.ts",
  "packages/worker-runtime/src/worker-export.ts",
  "packages/worker-runtime/src/worker-notification-dispatch.ts",
  "packages/worker-runtime/src/worker-periodic-scheduler.ts",
  "scripts/backup.ts",
];

const retiredProductionTerms = [
  "notification_channels",
  "notification_events",
  "webhook_deliveries",
  "gateway_runtime_status",
  "runtime_errors",
  "quality_first",
  "request_logging_enabled",
  "billing_reconciliation",
];

describe("core release guards", () => {
  it("tracks exactly nine passing core milestones", () => {
    const tracker = JSON.parse(readFileSync(join(repoRoot, "feature_list.json"), "utf8")) as {
      features: Array<{ id: string; status: string; verification: string }>;
    };
    expect(tracker.features.map(({ id }) => id)).toEqual(milestoneIds);
    for (const feature of tracker.features) {
      expect(feature.status).toBe("passing");
      expect(feature.verification).toContain("tests/features/");
      expect(feature.verification).toContain("tests/e2e/");
    }
  });

  it("keeps retired routes and modules deleted", () => {
    expect(retiredPaths.filter((path) => existsSync(join(repoRoot, path)))).toEqual([]);
  });

  it("keeps retired tables, configuration, and behavior out of production", () => {
    const sources = listFiles(join(repoRoot, "apps"))
      .concat(listFiles(join(repoRoot, "packages")))
      .concat(listFiles(join(repoRoot, "scripts")))
      .concat([join(repoRoot, ".env.example"), join(repoRoot, "docker-compose.yml")])
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    for (const retired of retiredProductionTerms) {
      expect(sources, retired).not.toContain(retired);
    }
    for (const config of [
      "GATEWAY_METRICS_TOKEN",
      "OTEL_",
      "WORKER_WEBHOOK_",
      "BACKUP_ENCRYPTION_KEY",
    ]) {
      expect(sources, config).not.toContain(config);
    }
  });

  it("keeps one core migration and three persistent Worker handlers", () => {
    expect(
      readdirSync(join(repoRoot, "packages/db/migrations")).filter((name) => name.endsWith(".sql")),
    ).toEqual(["0001_core_baseline.sql"]);

    const workerMain = readFileSync(join(repoRoot, "apps/worker/src/main.ts"), "utf8");
    const handlers = [...workerMain.matchAll(/^\s{6}([a-z_]+): create\w+JobHandler/gm)]
      .map(([, jobType]) => jobType)
      .sort();
    expect(handlers).toEqual(["model_refresh", "price_sync", "provider_connection_probe"]);
  });

  it("keeps app shells thin and stale artifacts absent", () => {
    expect(
      listFiles(join(repoRoot, "apps/worker/src")).map((file) => relative(repoRoot, file)),
    ).toEqual(["apps/worker/src/main.ts"]);
    for (const path of [
      "docs/PLAN.md",
      "session-handoff.md",
      "scripts/console-screenshots.mts",
      "scripts/console-e2e-coverage.ts",
    ]) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }
  });
});

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (
    root.endsWith("/.llmingress") ||
    root.endsWith("/.next") ||
    root.endsWith("/dist") ||
    root.endsWith("/node_modules")
  ) {
    return [];
  }
  return readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (
        entry.endsWith("/.llmingress") ||
        entry.endsWith("/node_modules") ||
        entry.endsWith("/.next") ||
        entry.endsWith("/dist") ||
        entry.includes("/node_modules/") ||
        entry.includes("/.next/") ||
        entry.includes("/dist/")
      ) {
        return [];
      }
      if (statSync(entry).isDirectory()) {
        return listFiles(entry);
      }
      return /\.(?:ts|tsx|sql|json|md|mjs)$/.test(entry) ? [entry] : [];
    });
}
