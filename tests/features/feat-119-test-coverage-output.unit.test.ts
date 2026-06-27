import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("feat-119 terminal coverage output", () => {
  it("keeps pnpm test wired to Vitest V8 coverage with terminal summary output", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const vitestConfig = readFileSync(resolve(root, "vitest.config.ts"), "utf8");

    expect(packageJson.devDependencies["@vitest/coverage-v8"]).toBe("4.1.8");
    expect(packageJson.scripts.test).toBe("tsx scripts/run-with-env.ts vitest run --coverage");
    expect(vitestConfig).toContain('provider: "v8"');
    expect(vitestConfig).toContain('reporter: ["text-summary"]');
  });
});
