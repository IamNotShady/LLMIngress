import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/ci.yml");

describe("feat-005 CI verification pipeline", () => {
  it("defines a GitHub Actions workflow with the base verification commands", () => {
    expect(existsSync(workflowPath)).toBe(true);

    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm run lint");
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm test:e2e");
    expect(workflow).toContain("pnpm build");
  });

  it("does not include migration validation in the base CI feature", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).not.toMatch(/db:migrate:check|migration validation/i);
  });

  it("keeps PostgreSQL fixture E2E opt-in for the base e2e command", () => {
    const postgresE2e = readFileSync(
      resolve(root, "tests/e2e/feat-003-postgres-fixture.e2e.spec.ts"),
      "utf8",
    );

    expect(postgresE2e).toContain("TEST_DATABASE_URL");
    expect(postgresE2e).toMatch(/test\.skip\(\s*!process\.env\.TEST_DATABASE_URL/);
  });

  it("provides PostgreSQL to CI so database E2E tests do not silently skip", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("services:");
    expect(workflow).toContain("postgres:");
    expect(workflow).toContain("POSTGRES_PASSWORD: postgres");
    expect(workflow).toContain("TEST_DATABASE_URL");
    expect(workflow).toContain("postgresql://postgres:postgres@127.0.0.1:55432/postgres");
  });
});
