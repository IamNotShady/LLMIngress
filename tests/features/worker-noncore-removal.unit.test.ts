import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

const removedWorkerModules = [
  "worker-alert-utils.ts",
  "worker-backup.ts",
  "worker-billing-reconciliation.ts",
  "worker-budget-threshold-alerts.ts",
  "worker-cost-report-export.ts",
  "worker-fallback-exhaustion-alerts.ts",
  "worker-jsonl-export.ts",
  "worker-notification-dispatcher.ts",
  "worker-provider-failure-alerts.ts",
  "worker-rate-limit-alerts.ts",
  "worker-webhook-export.ts",
  "worker-webhook-transport.ts",
];

describe("worker non-core removal", () => {
  it("removes alerting, notifications, exports, backup, and billing reconciliation", () => {
    for (const moduleName of removedWorkerModules) {
      expect(
        existsSync(join(repoRoot, "packages/worker-runtime/src", moduleName)),
        moduleName,
      ).toBe(false);
    }

    expect(existsSync(join(repoRoot, "scripts/backup.ts"))).toBe(false);
    expect(
      existsSync(join(repoRoot, "apps/console/src/app/api/notification-channels/route.ts")),
    ).toBe(false);
    expect(existsSync(join(repoRoot, "packages/db/src/console-notification-channels.ts"))).toBe(
      false,
    );
  });

  it("registers only core provider jobs", () => {
    const workerMain = readFileSync(join(repoRoot, "apps/worker/src/main.ts"), "utf8");
    const registeredHandlers = [
      ...workerMain.matchAll(/^\s{6}([a-z_]+): create\w+JobHandler/gm),
    ].map(([, jobType]) => jobType);

    expect(registeredHandlers.sort()).toEqual(
      ["model_refresh", "price_sync", "provider_connectivity_check"].sort(),
    );
  });

  it("does not expose removed commands or notification domain vocabulary", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts["db:backup"]).toBeUndefined();

    const dbPackage = JSON.parse(
      readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(dbPackage.exports["./console-notification-channels"]).toBeUndefined();

    const domainSource = readFileSync(join(repoRoot, "packages/domain/src/index.ts"), "utf8");
    expect(domainSource).not.toContain("notificationChannelTypes");
  });
});
