import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const productionSourceRoots = [
  "apps/console/src",
  "apps/gateway/src",
  "apps/worker/src",
  "packages/config/src",
  "packages/provider/src",
];
const packageManifestsWithoutPg = [
  "apps/console/package.json",
  "apps/gateway/package.json",
  "apps/worker/package.json",
  "packages/config/package.json",
];

describe("shared package boundaries", () => {
  it("keeps pg imports inside @llmingress/db for production source", () => {
    const offenders = productionSourceRoots.flatMap((root) =>
      listSourceFiles(join(repoRoot, root)).filter((file) => importsPg(readFileSync(file, "utf8"))),
    );

    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });

  it("keeps pg as a package dependency only in @llmingress/db", () => {
    const offenders = packageManifestsWithoutPg.filter((manifestPath) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      return Boolean(manifest.dependencies?.pg);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps production SQL execution inside @llmingress/db", () => {
    const offenders = productionSourceRoots.flatMap((root) =>
      listSourceFiles(join(repoRoot, root)).filter((file) => {
        const source = readFileSync(file, "utf8");
        return executesSql(source) || usesLowLevelDbClient(source);
      }),
    );

    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });

  it("keeps production database URL ownership inside @llmingress/db", () => {
    const offenders = productionSourceRoots.flatMap((root) =>
      listSourceFiles(join(repoRoot, root)).filter((file) =>
        usesDatabaseUrl(readFileSync(file, "utf8")),
      ),
    );

    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });
});

function listSourceFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const entries = readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (statSync(entry).isDirectory()) {
        return listSourceFiles(entry);
      }
      return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [entry] : [];
    });

  return entries;
}

function importsPg(source: string): boolean {
  return /\bfrom\s+["']pg["']|\brequire\(["']pg["']\)/.test(source);
}

function executesSql(source: string): boolean {
  return /\.query\s*\(/.test(source);
}

function usesLowLevelDbClient(source: string): boolean {
  return /\b(PostgresClient|PostgresQueryClient|PostgresQueryResultRow|withPostgresClient)\b/.test(
    source,
  );
}

function usesDatabaseUrl(source: string): boolean {
  return /\b(databaseUrl|DATABASE_URL)\b/.test(source);
}
