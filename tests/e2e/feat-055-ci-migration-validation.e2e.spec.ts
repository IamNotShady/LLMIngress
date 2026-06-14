import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("migration validation command runs cleanly against test postgres", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required for migration check.");

  const result = spawnSync("pnpm", ["run", "db:migrate:check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain("Migration check passed");
});
