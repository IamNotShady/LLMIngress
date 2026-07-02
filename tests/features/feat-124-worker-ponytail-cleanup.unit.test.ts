import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const removedDbAliasImports = [
  "@llmingress/db/jobs",
  "@llmingress/db/notifications",
  "@llmingress/db/maintenance",
];
const removedIdentitySymbols = [
  "buildNotificationDeliveryPayload",
  "redactWebhookExportValue",
  "summarizeExpiredBudgetReservationRelease",
  "StartWorkerOptions",
  "[worker] heartbeat",
];

describe("feat-124 worker ponytail cleanup", () => {
  it("keeps the worker app as the process shell only", () => {
    const files = readdirSync(join(repoRoot, "apps/worker/src"))
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(files).toEqual(["main.ts"]);
  });

  it("imports worker runtime modules directly from the db package", () => {
    const main = readFileSync(join(repoRoot, "apps/worker/src/main.ts"), "utf8");

    expect(main).toContain("@llmingress/db/worker-job-runner");
    expect(main).toContain("@llmingress/db/worker-periodic-scheduler");
    expect(main).not.toMatch(/from "\.\/(?!main)[^"]+\.js"/);
  });

  it("removes db compatibility alias subpath exports", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };

    expect(manifest.exports).not.toHaveProperty("./jobs");
    expect(manifest.exports).not.toHaveProperty("./notifications");
    expect(manifest.exports).not.toHaveProperty("./maintenance");
  });

  it("does not import removed db alias subpaths from source", () => {
    const files = readTextFilesFromRoots([
      "apps/console/src",
      "apps/gateway/src",
      "apps/worker/src",
      "packages",
      "tests/e2e",
      "tests/features",
    ]);

    for (const importPath of removedDbAliasImports) {
      expect(filesWithText(files, importPath), importPath).toEqual([]);
    }
  });

  it("removes identity and test-only worker helpers", () => {
    const files = readTextFilesFromRoots(["apps/worker/src", "packages/db/src", "tests"]);

    for (const symbol of removedIdentitySymbols) {
      expect(filesWithText(files, symbol), symbol).toEqual([]);
    }
  });
});

function readTextFilesFromRoots(relativeRoots: string[]): string[] {
  return relativeRoots.flatMap((relativeRoot) => readTextFiles(join(repoRoot, relativeRoot)));
}

function filesWithText(files: string[], text: string): string[] {
  return files
    .filter((filePath) => readFileSync(filePath, "utf8").includes(text))
    .map((filePath) => filePath.slice(repoRoot.length + 1))
    .sort();
}

function readTextFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || ["dist", "node_modules"].includes(entry.name)) {
        return [];
      }
      return readTextFiles(filePath);
    }
    if (
      filePath.includes("feat-124-worker-ponytail-cleanup.") ||
      filePath.includes("feat-125-packages-ponytail-cleanup.")
    ) {
      return [];
    }
    return /\.(ts|tsx|json)$/.test(entry.name) ? [filePath] : [];
  });
}
