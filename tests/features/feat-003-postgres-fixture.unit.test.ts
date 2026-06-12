import { describe, expect, it } from "vitest";
import { buildIsolatedDatabaseUrl, readTestDatabaseUrl } from "../../packages/db/src/index";

describe("feat-003 postgres fixture unit contract", () => {
  it("requires TEST_DATABASE_URL", () => {
    expect(() => readTestDatabaseUrl({})).toThrow(/TEST_DATABASE_URL/);
  });

  it("reads TEST_DATABASE_URL when present", () => {
    const url = "postgresql://postgres:postgres@127.0.0.1:55432/postgres";

    expect(readTestDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
  });

  it("derives isolated database urls from the maintenance database url", () => {
    const maintenanceUrl = "postgresql://postgres:postgres@127.0.0.1:55432/postgres";

    expect(buildIsolatedDatabaseUrl(maintenanceUrl, "llmingress_test_123")).toBe(
      "postgresql://postgres:postgres@127.0.0.1:55432/llmingress_test_123",
    );
  });
});
