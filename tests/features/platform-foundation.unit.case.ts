import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBootstrapRuntimeConfig } from "../../packages/config/src";
import { loadSqlMigrations } from "../../packages/db/src";
import { readPostgresDatabaseUrl } from "../../packages/db/src/client";
import { shippedSqlMigrations } from "../../packages/db/src/migration-status";
import { formatShellExports, loadEnvFiles, parseEnvFile } from "../../scripts/env-loader";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("platform foundation", () => {
  it("loads env files without overriding shell values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "llmingress-env-loader-"));
    createdDirectories.push(directory);
    const env = { SHELL_ONLY: "from-shell" };

    await writeFile(
      join(directory, ".env"),
      [
        "TEST_DATABASE_URL=postgresql://from-env",
        "OPENAI_API_KEY=sk-from-env",
        "SHELL_ONLY=from-env",
      ].join("\n"),
    );
    await writeFile(join(directory, ".env.local"), "OPENAI_API_KEY=sk-from-local\n");

    expect(loadEnvFiles({ cwd: directory, env }).loadedFiles.map((file) => file.name)).toEqual([
      ".env",
      ".env.local",
    ]);
    expect(env).toMatchObject({
      OPENAI_API_KEY: "sk-from-local",
      SHELL_ONLY: "from-shell",
      TEST_DATABASE_URL: "postgresql://from-env",
    });
  });

  it("parses shell env syntax and formats safe exports", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/app'",
          'ENCRYPTION_KEY="test-master-key"',
          "EMPTY_VALUE=",
        ].join("\n"),
      ),
    ).toEqual({
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
      EMPTY_VALUE: "",
      ENCRYPTION_KEY: "test-master-key",
    });

    expect(formatShellExports({ OPENAI_API_KEY: "sk-test'quote" })).toBe(
      "export OPENAI_API_KEY='sk-test'\\''quote'\n",
    );
  });

  it("reads bootstrap and postgres config at the platform boundary", () => {
    expect(
      loadBootstrapRuntimeConfig({
        env: {
          CONSOLE_PORT: "3100",
          DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
          GATEWAY_PORT: "4100",
          ENCRYPTION_KEY: "test-master-key",
          WORKER_HEARTBEAT_MS: "1000",
        },
      }),
    ).toMatchObject({
      consolePort: 3100,
      gatewayPort: 4100,
      encryptionKeySource: { kind: "inline", value: "test-master-key" },
      workerHeartbeatMs: 1000,
    });

    expect(() => readPostgresDatabaseUrl({ env: {} })).toThrow(/DATABASE_URL/);
    expect(() => readPostgresDatabaseUrl({ env: { DATABASE_URL: "not-a-url" } })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("keeps the migration manifest aligned with loaded SQL", () => {
    expect(loadSqlMigrations().map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "0001", name: "core_baseline" },
      { id: "0002", name: "provider_quota" },
    ]);
    expect(shippedSqlMigrations).toEqual(
      loadSqlMigrations().map(({ checksum, id, name }) => ({ checksum, id, name })),
    );
  });

  it("keeps test and startup scripts behind the env-aware wrappers", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const initScript = await readFile("init.sh", "utf8");

    expect(packageJson.scripts.test).toBe("tsx scripts/run-with-env.ts vitest run --coverage");
    expect(packageJson.scripts["test:e2e"]).toBe("tsx scripts/run-with-env.ts playwright test");
    expect(packageJson.scripts.verify).toBe(
      "pnpm run lint && pnpm run typecheck && pnpm test && pnpm run build",
    );
    expect(packageJson.scripts["verify:features"]).toBe(
      "tsx scripts/run-with-env.ts node scripts/verify-features.mjs",
    );
    expect(initScript.indexOf("scripts/print-env-exports.ts")).toBeLessThan(
      initScript.indexOf("pnpm run verify"),
    );
  });
});
