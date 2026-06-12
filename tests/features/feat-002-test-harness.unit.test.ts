import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

describe("feat-002 test harness", () => {
  it("keeps unit and e2e test commands separate", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBeTruthy();
    expect(pkg.scripts["test:e2e"]).toBeTruthy();
    expect(pkg.scripts["test:e2e"]).not.toBe(pkg.scripts.test);
  });

  it("keeps unit and e2e test directories separate", () => {
    expect(existsSync(resolve(root, "tests/features"))).toBe(true);
    expect(existsSync(resolve(root, "tests/e2e"))).toBe(true);
  });

  it("does not allow vitest to pass with no tests", () => {
    const config = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/passWithNoTests:\s*false/);
    expect(config).not.toMatch(/passWithNoTests:\s*true/);
  });

  it("scopes vitest to unit tests and playwright to e2e specs", () => {
    const vitestConfig = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
    expect(vitestConfig).toContain("tests/**/*.test.ts");

    const playwrightConfig = readFileSync(resolve(root, "playwright.config.ts"), "utf8");
    expect(playwrightConfig).toContain("tests/e2e");
    expect(playwrightConfig).toContain("e2e.spec");
  });
});
