import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("feat-120 E2E frontend coverage command", () => {
  it("retires the separate Console frontend coverage command", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).not.toHaveProperty("test:e2e:coverage");
    expect(existsSync(resolve(root, "scripts/console-e2e-coverage.ts"))).toBe(false);
    expect(packageJson.scripts.test).toBe("tsx scripts/run-with-env.ts vitest run --coverage");
  });
});
