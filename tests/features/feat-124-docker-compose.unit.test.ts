import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("feat-124 Docker Compose runtime", () => {
  it("builds one shared app image for Gateway Console Worker and migrations", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS base");
    expect(dockerfile).toContain("RUN pnpm run build");
    expect(dockerfile).toContain("COPY --from=build /app /app");
    expect(dockerfile).toContain(
      'CMD ["pnpm", "--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"]',
    );
  });

  it("defines Postgres plus app services that reuse the same image", () => {
    const compose = readProjectFile("docker-compose.yml");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("image: postgres:16-alpine");
    expect(compose).toContain("llmingress-app: &llmingress-app");
    expect(compose).toContain("migrate:");
    expect(compose).toContain("gateway:");
    expect(compose).toContain("console:");
    expect(compose).toContain("worker:");
    expect(compose).toContain(
      "DATABASE_URL: postgresql://postgres:postgres@postgres:5432/postgres",
    );
    expect(compose).toContain("CONSOLE_HOST: 0.0.0.0");
    expect(compose).toContain("pnpm run db:migrate");
    expect(compose).toContain("pnpm --filter @llmingress/gateway exec tsx src/main.ts");
    expect(compose).toContain("pnpm --filter @llmingress/console start");
    expect(compose).toContain("pnpm --filter @llmingress/worker exec tsx src/main.ts");
  });

  it("keeps local secrets and generated artifacts out of the image context", () => {
    const dockerignore = readProjectFile(".dockerignore");

    expect(dockerignore).toContain(".env");
    expect(dockerignore).toContain(".env.local");
    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain("**/.next");
    expect(dockerignore).toContain(".turbo");
    expect(dockerignore).toContain(".worktrees");
  });
});

function readProjectFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}
