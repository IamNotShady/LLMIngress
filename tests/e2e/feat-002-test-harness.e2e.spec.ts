import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(__dirname, "../..");

test("missing tests fail and unit e2e commands are separate", () => {
  const missingRun = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "tests/features/__missing__.unit.test.ts"],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  expect(missingRun.status).not.toBe(0);

  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  expect(pkg.scripts.test).toBeTruthy();
  expect(pkg.scripts["test:e2e"]).toBeTruthy();
  expect(pkg.scripts["test:e2e"]).not.toBe(pkg.scripts.test);

  expect(existsSync(resolve(root, "tests/features"))).toBe(true);
  expect(existsSync(resolve(root, "tests/e2e"))).toBe(true);
});
