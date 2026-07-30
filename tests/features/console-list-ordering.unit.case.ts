import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const newestFirst = /order by [\w.]+\.created_at desc,\s+[\w.]+\.id desc/;

describe("console list ordering", () => {
  test.each([
    "packages/db/src/console-providers.ts",
    "packages/db/src/console-api-keys.ts",
    "packages/db/src/console-virtual-models.ts",
    "packages/db/src/console-activity.ts",
  ])("%s keeps newest records first with a stable tie-breaker", (path) => {
    expect(readFileSync(path, "utf8")).toMatch(newestFirst);
  });
});
