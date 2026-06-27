import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(__dirname, "../..");
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

test("prints coverage summary after pnpm test finishes", () => {
  const result = spawnSync(
    "pnpm",
    ["test", "--", "tests/features/feat-119-test-coverage-output.unit.test.ts"],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(ansiPattern, "");

  expect(output).toContain("Coverage report from v8");
  expect(output).toContain("Statements");
  expect(output).toContain("Branches");
  expect(output).toContain("Functions");
  expect(output).toContain("Lines");
  expect(result.status).toBe(0);
});
