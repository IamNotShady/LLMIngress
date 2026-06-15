import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("feat-055 CI migration validation", () => {
  it("adds a migration validation script and CI workflow step", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts["db:migrate:check"]).toBe(
      "tsx scripts/run-with-env.ts tsx scripts/migrate-check.ts",
    );
    expect(existsSync(resolve(root, "scripts/migrate-check.ts"))).toBe(true);
    expect(workflow).toContain("name: Migration validation");
    expect(workflow).toContain("pnpm run db:migrate:check");
  });
});
