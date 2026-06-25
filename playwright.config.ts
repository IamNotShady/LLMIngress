import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.spec.ts",
  timeout: 180_000,
  // Retry in CI only: Console pages compile on-demand on first visit, so a cold
  // first attempt can exceed an assertion's wait; the retry hits the warm page.
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
});
