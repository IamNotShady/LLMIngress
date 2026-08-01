import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayPublicBaseUrl, loadBootstrapRuntimeConfig } from "../../packages/config/src";
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

  it("loads root dev through the shared env precedence and derives the public Gateway URL", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBe(
      "tsx scripts/run-with-env.ts turbo run dev --parallel --env-mode=loose",
    );
    expect(gatewayPublicBaseUrl({ GATEWAY_PORT: "4100" })).toBe("http://127.0.0.1:4100");
    expect(
      gatewayPublicBaseUrl({
        GATEWAY_PORT: "4100",
        GATEWAY_URL: " https://gateway.example.test ",
      }),
    ).toBe("https://gateway.example.test");
  });

  it("documents supported environment variables by module without stale or active empty entries", () => {
    const exampleEnv = readFileSync(".env.example", "utf8");
    const sectionNames = [
      "Shared service endpoints",
      "Docker Compose",
      "Local init.sh and pnpm dev",
      "Tests",
      "Gateway",
      "Worker",
      "Provider OAuth",
    ];
    const documentedKeys = [
      "COMPOSE_DATABASE_URL",
      "CONSOLE_HOST",
      "CONSOLE_PORT",
      "CONSOLE_PUBLISH_HOST",
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "ENCRYPTION_KEY_FILE",
      "GATEWAY_BODY_LIMIT_BYTES",
      "GATEWAY_BREAKER_ENABLED",
      "GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT",
      "GATEWAY_BREAKER_HALF_OPEN_AFTER_MS",
      "GATEWAY_BREAKER_HALF_OPEN_CALLS",
      "GATEWAY_BREAKER_MIN_REQUESTS",
      "GATEWAY_BREAKER_WINDOW_MS",
      "GATEWAY_CONFIG_NOTIFICATIONS",
      "GATEWAY_CONFIG_RECONCILE_INTERVAL_MS",
      "GATEWAY_CORS_ALLOWED_ORIGINS",
      "GATEWAY_DEBUG_REQUEST_METADATA",
      "GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS",
      "GATEWAY_HOST",
      "GATEWAY_PORT",
      "GATEWAY_PROVIDER_RETRIES",
      "GATEWAY_PROVIDER_RETRY_INITIAL_DELAY_MS",
      "GATEWAY_PUBLISH_HOST",
      "GATEWAY_READINESS_TIMEOUT_MS",
      "GATEWAY_SHUTDOWN_DRAIN_MS",
      "GATEWAY_STREAM_CONNECT_TIMEOUT_MS",
      "GATEWAY_STREAM_IDLE_TIMEOUT_MS",
      "GATEWAY_URL",
      "GROK_OAUTH_CLIENT_ID",
      "LLMINGRESS_BOOTSTRAP_CONFIG",
      "LLMINGRESS_DB_POOL_MAX",
      "LOG_LEVEL",
      "MINIMAX_OAUTH_CLIENT_ID",
      "POSTGRES_PORT",
      "POSTGRES_PUBLISH_HOST",
      "PROVIDER_REQUEST_TIMEOUT_MS",
      "RETENTION_CLEANUP_INTERVAL_MS",
      "SKIP_VERIFY",
      "TEST_DATABASE_URL",
      "WORKER_ACTIVITY_RETENTION_DAYS",
      "WORKER_HEALTH_EVENT_RETENTION_DAYS",
      "WORKER_HEARTBEAT_MS",
      "WORKER_ID",
      "WORKER_JOB_LEASE_MS",
      "WORKER_JOB_RETENTION_DAYS",
      "WORKER_MAX_JOB_DURATION_MS",
      "WORKER_MODEL_CATALOG_CACHE_TTL_MS",
      "WORKER_SHUTDOWN_GRACE_MS",
    ];

    for (const sectionName of sectionNames) {
      expect(exampleEnv).toContain(`# ${sectionName}`);
    }
    for (const key of documentedKeys) {
      expect(exampleEnv, key).toMatch(new RegExp(`^#? ${key}=|^${key}=`, "m"));
    }
    expect(exampleEnv).not.toMatch(/^[A-Z][A-Z0-9_]*=$/m);
    expect(exampleEnv).not.toMatch(
      /^(?:# )?(?:LLMINGRESS_REAL_SMOKE|OPENAI_API_KEY|ANTHROPIC_API_KEY)=/m,
    );
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
      { id: "0003", name: "provider_oauth_device" },
      { id: "0004", name: "route_policy_candidate_tags" },
      { id: "0005", name: "api_key_request_logging" },
      { id: "0006", name: "route_policy_candidate_weights" },
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
    // The gate is lint → typecheck (packages, then the scripts that drive
    // them) → test → build, in that order and with nothing skipped.
    expect(packageJson.scripts.verify).toBe(
      "pnpm run lint && pnpm run typecheck && pnpm run typecheck:scripts && pnpm test && pnpm run build",
    );
    expect(packageJson.scripts["typecheck:scripts"]).toBe("tsc -p tsconfig.scripts.json --noEmit");
    expect(packageJson.scripts["verify:features"]).toBe(
      "tsx scripts/run-with-env.ts node scripts/verify-features.mjs",
    );
    expect(initScript.indexOf("scripts/print-env-exports.ts")).toBeLessThan(
      initScript.indexOf("pnpm run verify"),
    );
  });
});
