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

describe("shared logger", () => {
  it("provides a shared pino logger package", () => {
    const logging = readFileSync("packages/logging/src/index.ts", "utf8");
    expect(logging).toContain('from "pino"');
    expect(logging).toContain("export function createLogger");
  });

  it("leaves no bare console calls in app or package source", () => {
    const roots = ["apps/gateway/src", "apps/worker/src", "apps/console/src"].concat(
      readdirSync("packages").map((name) => join("packages", name, "src")),
    );
    const offenders = roots
      .flatMap((root) => listSourceFiles(root))
      .filter((file) => /console\.(log|error|warn)\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("blocks console regressions through biome", () => {
    const biome = JSON.parse(readFileSync("biome.json", "utf8"));
    expect(biome.linter.rules.suspicious.noConsole).toBe("error");
  });
});
