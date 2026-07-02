import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const allowedFeatureIds = [
  "v1-platform",
  "v1-gateway-routing",
  "v1-console",
  "v1-worker-ops",
  "v1-release-guards",
];

describe("v1 release guards milestone", () => {
  it("tracks V1 as five milestone features", () => {
    const featureList = readJson<{
      features: Array<{ id: string; status: string; verification: string }>;
    }>("feature_list.json");

    expect(featureList.features.map((feature) => feature.id)).toEqual(allowedFeatureIds);
    for (const feature of featureList.features) {
      expect(feature.status).toBe("passing");
      expect(feature.verification).toContain(`tests/features/${feature.id}.unit.test.ts`);
      expect(feature.verification).toContain(`tests/e2e/${feature.id}.e2e.spec.ts`);
    }
  });

  it("keeps stale generated artifacts and one-off docs out of the repo", () => {
    const stalePaths = [
      "apps/worker/.llmingress/backups/llmingress-backup-scheduled-2026-06-17T00-00-00-000Z.json",
      "apps/worker/.llmingress/backups/llmingress-backup-scheduled-2026-06-18T00-00-00-000Z.json",
      "docs/PLAN.md",
      "docs/console-ui-operator-grade-polish-implementation.md",
      "session-handoff.md",
      "scripts/console-screenshots.mts",
      "scripts/console-e2e-coverage.ts",
    ];
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");

    expect(stalePaths.filter((file) => existsSync(join(repoRoot, file)))).toEqual([]);
    expect(gitignore).toMatch(/(^|\n)\.llmingress\/(\n|$)/);
    expect(gitignore).toMatch(/(^|\n)\.worktrees\/(\n|$)/);
  });

  it("keeps app shells thin and shared code in packages", () => {
    expect(
      listFiles(join(repoRoot, "apps/console/src/server")).map((file) => relative(repoRoot, file)),
    ).toEqual([]);
    expect(
      listFiles(join(repoRoot, "apps/worker/src"))
        .map((file) => relative(repoRoot, file))
        .sort(),
    ).toEqual(["apps/worker/src/main.ts"]);
    expect(existsSync(join(repoRoot, "packages/observability/package.json"))).toBe(false);

    const offenders = listSourceFiles("apps", "packages", "scripts", "tests")
      .filter(
        (file) => relative(repoRoot, file) !== "tests/features/v1-release-guards.unit.test.ts",
      )
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          source.includes("@llmingress/observability") ||
          source.includes("packages/observability") ||
          /apps\/console\/src\/server|apps\/worker\/src\/(?!main)|\.\.\/server/.test(source)
        );
      })
      .map((file) => relative(repoRoot, file));

    expect(offenders).toEqual([]);
  });

  it("keeps retired Console UI complexity deleted", () => {
    const sections = readFileSync(
      join(repoRoot, "apps/console/src/app/_modules/sections.tsx"),
      "utf8",
    );
    const globals = readFileSync(join(repoRoot, "apps/console/src/app/globals.css"), "utf8");
    const nav = readFileSync(join(repoRoot, "apps/console/src/app/_lib/nav.ts"), "utf8");

    expect(
      existsSync(join(repoRoot, "apps/console/src/app/_components/date-picker-input.tsx")),
    ).toBe(false);
    expect(sections).not.toContain("DatePickerInput");
    expect(sections).toContain('type="date"');
    expect(globals).not.toContain("date-picker-");
    expect(nav).toContain("export const consoleNavItems");
    expect(nav).not.toContain("consoleNavGroups");
  });
});

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
