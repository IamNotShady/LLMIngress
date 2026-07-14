import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Console E2E harness", () => {
  it("uses isolated Next output and no cross-process lock", () => {
    const nextConfig = readFileSync("apps/console/next.config.ts", "utf8");
    const harness = readFileSync("tests/support/console-app.ts", "utf8");

    expect(nextConfig).toContain("LLMINGRESS_TEST_CONSOLE_DIST_DIR");
    expect(harness).toContain("LLMINGRESS_TEST_CONSOLE_DIST_DIR:");
    expect(harness).toContain("`.next/e2e-");
    expect(harness).toContain('LLMINGRESS_DB_POOL_MAX: "2"');
    expect(harness).toContain("rm(consoleApp.distDirectory");
    expect(existsSync("tests/support/process-lock.ts")).toBe(false);
  });
});
