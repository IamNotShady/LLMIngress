import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTestPostgresFixture, runMigrations } from "@llmingress/db";
import { createAdminPassword } from "@llmingress/db/console-auth";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";
import { loadBootstrapRuntimeConfig, readConsoleSetupMode } from "../../packages/config/src/index";

describe("console secure bootstrap", () => {
  it("keeps compose secrets required and host publishes loopback-bound by default", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const shell = "$";

    expect(compose).toContain(`${shell}{MASTER_KEY:?MASTER_KEY is required}`);
    expect(compose).toContain(`${shell}{POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}`);
    expect(compose).toContain(`${shell}{CONSOLE_SETUP_TOKEN:?CONSOLE_SETUP_TOKEN is required}`);
    expect(compose).not.toContain(`${shell}{MASTER_KEY:-`);
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

  it("requires setup tokens only for configured tokens or non-loopback console hosts", () => {
    expect(readConsoleSetupMode({ CONSOLE_HOST: "127.0.0.1" })).toEqual({
      kind: "password_only",
    });
    expect(readConsoleSetupMode({ CONSOLE_HOST: "localhost" })).toEqual({
      kind: "password_only",
    });
    expect(readConsoleSetupMode({ CONSOLE_HOST: "0.0.0.0" })).toEqual({
      kind: "locked",
    });
    expect(
      readConsoleSetupMode({
        CONSOLE_HOST: "0.0.0.0",
        CONSOLE_SETUP_TOKEN: "s".repeat(32),
      }),
    ).toEqual({
      kind: "token_required",
      token: "s".repeat(32),
    });
    expect(() => readConsoleSetupMode({ CONSOLE_SETUP_TOKEN: "short" })).toThrow(
      /CONSOLE_SETUP_TOKEN/,
    );
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
