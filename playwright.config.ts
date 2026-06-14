import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.spec.ts",
  timeout: 90_000,
  reporter: [["list"]],
});
