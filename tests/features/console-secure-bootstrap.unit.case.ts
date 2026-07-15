import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTestPostgresFixture, runMigrations } from "@llmingress/db";
import { createAdminPassword } from "@llmingress/db/console-auth";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";
import { loadBootstrapRuntimeConfig } from "../../packages/config/src/index";

describe("console secure bootstrap", () => {
  it("keeps compose local defaults and host publishes loopback-bound by default", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const shell = "$";

    expect(compose).toContain(
      `${shell}{MASTER_KEY:-llmi-local-master}`,
    );
    expect(compose).toContain(
      `${shell}{DATABASE_URL:-postgresql://postgres:llmi-local-db@postgres:5432/postgres}`,
    );
    expect(compose).toContain("POSTGRES_PASSWORD: llmi-local-db");
    expect(compose).not.toContain("CONSOLE_SETUP_TOKEN");
    expect(compose).not.toContain(`${shell}{MASTER_KEY:?`);
    expect(compose).not.toContain(`${shell}{POSTGRES_PASSWORD`);
    expect(compose).not.toContain("POSTGRES_PASSWORD: postgres");

    expect(compose).toContain("GATEWAY_HOST: 0.0.0.0");
    expect(compose).toContain("CONSOLE_HOST: 0.0.0.0");
    expect(compose).toContain(
      `"${shell}{GATEWAY_PUBLISH_HOST:-127.0.0.1}:${shell}{GATEWAY_PORT:-4000}:4000"`,
    );
    expect(compose).toContain(
      `"${shell}{CONSOLE_PUBLISH_HOST:-127.0.0.1}:${shell}{CONSOLE_PORT:-3000}:3000"`,
    );
    expect(compose).toContain(
      `"${shell}{POSTGRES_PUBLISH_HOST:-127.0.0.1}:${shell}{POSTGRES_PORT:-55432}:5432"`,
    );
    expect(compose).not.toContain('"4000:4000"');
    expect(compose).not.toContain('"3000:3000"');
    expect(compose).not.toContain(`"${shell}{POSTGRES_PORT:-55432}:5432"`);
  });

  it("has no setup token runtime or documented configuration surface", () => {
    const files = [
      ".env.example",
      "README.md",
      "docs/PRODUCT.md",
      "packages/config/src/index.ts",
      "apps/console/src/app/(dashboard)/layout.tsx",
      "apps/console/src/app/_components/auth-screens.tsx",
      "apps/console/src/app/_components/console-mutation-form.tsx",
      "apps/console/src/app/api/auth/setup/route.ts",
    ];

    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /CONSOLE_SETUP_TOKEN|console_setup_token|SetupLocked|readConsoleSetupMode|requiresSetupToken|setupToken/,
      );
    }
  });

  it("rejects the old public default master key in production unless explicitly allowed", () => {
    expect(() =>
      loadBootstrapRuntimeConfig({
        env: {
          MASTER_KEY: "test-master-key-change-me",
          NODE_ENV: "production",
        },
      }),
    ).toThrow(/default MASTER_KEY/i);

    expect(
      loadBootstrapRuntimeConfig({
        env: {
          LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY: "true",
          MASTER_KEY: "test-master-key-change-me",
          NODE_ENV: "production",
        },
      }).masterKeySource,
    ).toEqual({ kind: "inline", value: "test-master-key-change-me" });
  });

  it("creates the first admin with race-safe insert semantics", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_setup_race_${randomUUID().replaceAll("-", "_")}`,
    });

    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });

      const attempts = await Promise.allSettled([
        createAdminPassword(fixture.databaseUrl, "correct horse battery staple"),
        createAdminPassword(fixture.databaseUrl, "correct horse battery staple"),
      ]);
      const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
      const rejected = attempts.filter((attempt) => attempt.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConsoleOperationError);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "console_already_initialized",
        kind: "conflict",
      });

      const admins = await fixture.query("select count(*)::integer as count from console_admins");
      expect(admins.rows[0]?.count).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });
});
