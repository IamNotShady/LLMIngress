import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(__dirname, "../..");

test("prints Console frontend page coverage", () => {
  const result = spawnSync("pnpm", ["run", "test:e2e:coverage"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  expect(output).toContain("Console frontend page coverage");
  expect(output).toContain("Visited pages");
  expect(output).toContain("JavaScript bytes");
  expect(output).toContain("Overview");
  expect(output).toContain("Agents");
  expect(output).toContain("Settings");
  expect(result.status).toBe(0);
});
