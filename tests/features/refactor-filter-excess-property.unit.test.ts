import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function listSourceFiles(root: string): string[] {
  return readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (statSync(entry).isDirectory()) {
        if (entry.endsWith("node_modules") || entry.endsWith(".next")) {
          return [];
        }
        return listSourceFiles(entry);
      }
      return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [entry] : [];
    });
}

describe("refactor-filter-excess-property", () => {
  it("guards every built-then-passed filters object with satisfies", () => {
    const offenders = listSourceFiles("apps/console/src").filter((file) => {
      const source = readFileSync(file, "utf8");
      if (!source.includes("const filters = {")) {
        return false;
      }
      return !/const filters = \{[\s\S]*?\} satisfies \w+FiltersInput;/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the activity section site guarded", () => {
    const source = readFileSync("apps/console/src/app/_modules/activity-section.tsx", "utf8");
    expect(source).toContain("} satisfies ConsoleActivityFiltersInput;");
  });
});
