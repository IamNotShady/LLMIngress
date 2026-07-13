import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("console config transfer removal", () => {
  it("removes Console configuration import/export routes and package exports", () => {
    expect(existsSync(join(repoRoot, "apps/console/src/app/api/config-import/route.ts"))).toBe(
      false,
    );
    expect(existsSync(join(repoRoot, "apps/console/src/app/api/config-export/route.ts"))).toBe(
      false,
    );
    expect(existsSync(join(repoRoot, "packages/db/src/console-import-export.ts"))).toBe(false);

    const dbPackage = JSON.parse(
      readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"),
    ) as {
      exports: Record<string, unknown>;
    };
    expect(dbPackage.exports["./console-import-export"]).toBeUndefined();
  });

  it("does not replace removed Console config transfer with Worker backup or export", () => {
    for (const path of [
      "packages/worker-runtime/src/worker-backup.ts",
      "packages/worker-runtime/src/worker-jsonl-export.ts",
      "packages/worker-runtime/src/worker-cost-report-export.ts",
      "packages/worker-runtime/src/worker-webhook-export.ts",
    ]) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }

    const workerMain = readFileSync(join(repoRoot, "apps/worker/src/main.ts"), "utf8");
    expect(workerMain).not.toMatch(/Backup|Jsonl|CostReportExport|WebhookEventExport/);
  });

  it("documents only operational exports and database backup, not Console config transfer", () => {
    const product = readFileSync(join(repoRoot, "docs/PRODUCT.md"), "utf8");
    const architecture = readFileSync(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8");

    expect(product).not.toMatch(/config import\/export/i);
    expect(product).not.toMatch(/Export Provider \/ Model \/ Route Policy configuration/i);
    expect(product).not.toMatch(/Import configuration backups/i);
    expect(product).not.toMatch(/Export request records/i);
    expect(product).not.toMatch(/Export cost reports/i);
    expect(product).not.toMatch(/Automatically back up the configuration database/i);

    expect(architecture).not.toMatch(/data import\/export/i);
    expect(architecture).not.toMatch(/import\/export entry points/i);
    expect(architecture).not.toMatch(/JSONL \/ webhook export/i);
    expect(architecture).not.toMatch(/scheduled backup/i);
  });
});
