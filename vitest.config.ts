import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
        "**/tests/**",
        "apps/console/src/app/**/*.tsx",
        "apps/console/.next/**",
        "coverage/**",
        "test-results/**",
      ],
      include: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.ts",
        "scripts/**/*.{ts,mts,mjs,js}",
      ],
      provider: "v8",
      reporter: ["text-summary"],
    },
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
