import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("feat-126 safe ponytail cleanup", () => {
  it("removes checked-in runtime backups and ignores future local backups", () => {
    const trackedBackupFiles = [
      "apps/worker/.llmingress/backups/llmingress-backup-scheduled-2026-06-17T00-00-00-000Z.json",
      "apps/worker/.llmingress/backups/llmingress-backup-scheduled-2026-06-18T00-00-00-000Z.json",
    ];
    const existing = trackedBackupFiles.filter((file) => existsSync(join(repoRoot, file)));
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");

    expect(existing).toEqual([]);
    expect(gitignore).toMatch(/(^|\n)\.llmingress\/(\n|$)/);
  });

  it("removes stale one-off planning and handoff documents", () => {
    const staleDocs = [
      "docs/PLAN.md",
      "docs/console-ui-operator-grade-polish-implementation.md",
      "docs/superpowers/plans/2026-06-25-stream-usage-cost.md",
      "docs/superpowers/specs/2026-06-23-console-ui-refresh-design.md",
      "docs/superpowers/specs/2026-06-28-console-ui-polish-design.md",
      "session-handoff.md",
    ];

    expect(staleDocs.filter((file) => existsSync(join(repoRoot, file)))).toEqual([]);
  });

  it("retires the report-only Console E2E coverage command", () => {
    const packageJson = readJson<PackageManifest>("package.json");

    expect(packageJson.scripts).not.toHaveProperty("test:e2e:coverage");
    expect(existsSync(join(repoRoot, "scripts/console-e2e-coverage.ts"))).toBe(false);
  });

  it("uses native Usage date inputs instead of a custom calendar component", () => {
    const sections = readFileSync(
      join(repoRoot, "apps/console/src/app/_modules/sections.tsx"),
      "utf8",
    );
    const globals = readFileSync(join(repoRoot, "apps/console/src/app/globals.css"), "utf8");

    expect(
      existsSync(join(repoRoot, "apps/console/src/app/_components/date-picker-input.tsx")),
    ).toBe(false);
    expect(sections).not.toContain("DatePickerInput");
    expect(sections).toContain('type="date"');
    expect(globals).not.toContain("date-picker-");
  });

  it("removes app-layer re-export shims and imports db-owned modules directly", () => {
    expect(
      listFiles(join(repoRoot, "apps/console/src/server")).map((file) => relative(repoRoot, file)),
    ).toEqual([]);
    expect(
      listFiles(join(repoRoot, "apps/worker/src"))
        .map((file) => relative(repoRoot, file))
        .sort(),
    ).toEqual(["apps/worker/src/main.ts"]);

    const offenders = listSourceFiles("apps", "tests", "scripts")
      .filter(
        (file) => !file.endsWith("tests/features/feat-126-safe-ponytail-cleanup.unit.test.ts"),
      )
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /apps\/console\/src\/server|apps\/worker\/src\/(?!main)|\.\.\/server|\.{2}\/\.{2}\/server/.test(
          source,
        );
      })
      .map((file) => relative(repoRoot, file));

    expect(offenders).toEqual([]);
  });

  it("removes unused app dependencies and private db exports", () => {
    const consoleManifest = readJson<PackageManifest>("apps/console/package.json");
    const workerManifest = readJson<PackageManifest>("apps/worker/package.json");
    const dbManifest = readJson<PackageManifest>("packages/db/package.json");

    for (const dependency of [
      "@llmingress/billing",
      "@llmingress/domain",
      "@llmingress/provider",
      "@llmingress/security",
    ]) {
      expect(consoleManifest.dependencies).not.toHaveProperty(dependency);
    }
    for (const dependency of [
      "@llmingress/billing",
      "@llmingress/observability",
      "@llmingress/provider",
      "@llmingress/security",
    ]) {
      expect(workerManifest.dependencies).not.toHaveProperty(dependency);
    }
    for (const subpath of [
      "./gateway-budgets",
      "./gateway-fallback-chain",
      "./gateway-gateway-runtime-status",
      "./gateway-rate-limits",
    ]) {
      expect(dbManifest.exports).not.toHaveProperty(subpath);
    }
  });

  it("moves one-file observability helpers into db", () => {
    expect(existsSync(join(repoRoot, "packages/observability/package.json"))).toBe(false);

    const offenders = listSourceFiles("apps", "packages", "tests", "scripts")
      .filter(
        (file) => !file.endsWith("tests/features/feat-126-safe-ponytail-cleanup.unit.test.ts"),
      )
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          source.includes("@llmingress/observability") || source.includes("packages/observability")
        );
      })
      .map((file) => relative(repoRoot, file));

    expect(offenders).toEqual([]);
  });

  it("centralizes Console API form readers", () => {
    const helperPath = "apps/console/src/app/api/_form.ts";
    expect(existsSync(join(repoRoot, helperPath))).toBe(true);

    const duplicateHelpers = listSourceFiles("apps/console/src/app/api")
      .filter((file) => !file.endsWith("_form.ts"))
      .filter((file) =>
        /function read(Required|Optional)?(Text|Number|TextValues)\b/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(repoRoot, file));

    expect(duplicateHelpers).toEqual([]);
  });
});

type PackageManifest = {
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as T;
}

function listSourceFiles(...roots: string[]): string[] {
  return roots.flatMap((root) => listFiles(join(repoRoot, root)));
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (
    root.endsWith("/node_modules") ||
    root.endsWith("/dist") ||
    root.endsWith("/.next") ||
    root.includes("/node_modules/") ||
    root.includes("/dist/") ||
    root.includes("/.next/")
  ) {
    return [];
  }

  return readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (statSync(entry).isDirectory()) {
        return listFiles(entry);
      }
      return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [entry] : [];
    });
}
