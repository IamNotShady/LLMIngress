import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function listSourceFiles(root: string): string[] {
  return readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (statSync(entry).isDirectory()) {
        if (entry.endsWith("node_modules") || entry.endsWith("dist") || entry.endsWith(".next")) {
          return [];
        }
        return listSourceFiles(entry);
      }
      return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [entry] : [];
    });
}

describe("refactor-db-row-strict-types", () => {
  it("intersects no row type with the index-signature base", () => {
    const offenders = [
      ...listSourceFiles("packages/db/src"),
      ...listSourceFiles("packages/gateway-runtime/src"),
      ...listSourceFiles("packages/worker-runtime/src"),
      ...listSourceFiles("apps"),
    ].filter((file) => readFileSync(file, "utf8").includes("PostgresQueryResultRow & {"));
    expect(offenders).toEqual([]);
  });

  it("keeps the pg base types exported for query defaults", () => {
    const client = readFileSync("packages/db/src/client.ts", "utf8");
    expect(client).toContain("export type PostgresQueryResultRow");
  });

  it("drops the index-signature-driven casts", () => {
    const modelRefresh = readFileSync(
      "packages/worker-runtime/src/worker-model-refresh.ts",
      "utf8",
    );
    expect(modelRefresh).not.toContain("provider.base_url as string");
  });
});
