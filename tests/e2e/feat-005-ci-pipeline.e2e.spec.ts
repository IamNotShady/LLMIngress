import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("ci workflow contains install lint typecheck unit e2e and build gates", () => {
  const result = spawnSync(
    "bash",
    [
      "-lc",
      [
        "test -f .github/workflows/ci.yml",
        "grep -q 'pnpm install' .github/workflows/ci.yml",
        "grep -q 'pnpm run lint' .github/workflows/ci.yml",
        "grep -q 'pnpm typecheck' .github/workflows/ci.yml",
        "grep -q 'pnpm test' .github/workflows/ci.yml",
        "grep -q 'pnpm test:e2e' .github/workflows/ci.yml",
        "grep -q 'pnpm build' .github/workflows/ci.yml",
        "grep -q 'postgres:' .github/workflows/ci.yml",
        "grep -q 'TEST_DATABASE_URL' .github/workflows/ci.yml",
      ].join(" && "),
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
  );

  expect(result.status, result.stderr || result.stdout).toBe(0);
});
