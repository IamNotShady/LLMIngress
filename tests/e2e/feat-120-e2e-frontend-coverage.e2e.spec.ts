import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(__dirname, "../..");

test("retires separate Console frontend coverage command", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(packageJson.scripts).not.toHaveProperty("test:e2e:coverage");
  expect(existsSync(resolve(root, "scripts/console-e2e-coverage.ts"))).toBe(false);
});
