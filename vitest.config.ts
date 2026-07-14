import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
        "**/tests/**",
        // Process entrypoints, Next route adapters, and CLI wrappers are exercised
        // by process/browser E2E tests, which do not merge into Vitest's V8 report.
        "apps/*/src/main.ts",
        "apps/console/src/app/api/**",
        "apps/console/src/app/**/*.tsx",
        "apps/console/.next/**",
        "coverage/**",
        "scripts/**",
        "test-results/**",
      ],
      include: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.ts",
        "scripts/**/*.{ts,mts,mjs,js}",
      ],
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        branches: 38,
        functions: 50,
        lines: 45,
        statements: 45,
      },
    },
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
