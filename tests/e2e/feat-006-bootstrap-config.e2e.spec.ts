import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { loadBootstrapRuntimeConfig } from "../../packages/config/src/index";

test("env and bootstrap config load ports database url master key and reject invalid config", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "llmingress-bootstrap-"));

  try {
    const masterKeyFile = join(tempDir, "master-key");
    const bootstrapConfig = join(tempDir, "bootstrap.json");

    writeFileSync(masterKeyFile, "file-backed-master-key", "utf8");
    writeFileSync(
      bootstrapConfig,
      JSON.stringify({
        gatewayPort: 4101,
        consolePort: 3101,
        workerHeartbeatMs: 5000,
        databaseUrl: "postgresql://postgres:postgres@127.0.0.1:55432/from-config",
        masterKeyFile,
      }),
      "utf8",
    );

    const config = loadBootstrapRuntimeConfig({
      env: {
        LLMINGRESS_BOOTSTRAP_CONFIG: bootstrapConfig,
        GATEWAY_PORT: "4201",
      },
    });

    expect(config).toEqual({
      gatewayPort: 4201,
      consolePort: 3101,
      workerHeartbeatMs: 5000,
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:55432/from-config",
      masterKeySource: { kind: "file", path: masterKeyFile },
    });

    expect(() =>
      loadBootstrapRuntimeConfig({
        env: {
          LLMINGRESS_BOOTSTRAP_CONFIG: bootstrapConfig,
          DATABASE_URL: "not-a-url",
        },
      }),
    ).toThrow(/DATABASE_URL/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("app startup entries reject invalid bootstrap config before serving", () => {
  const appCommands = [
    {
      name: "gateway",
      command: "pnpm --filter @llmingress/gateway exec tsx src/main.ts",
    },
    {
      name: "worker",
      command: "pnpm --filter @llmingress/worker exec tsx src/main.ts",
    },
    {
      name: "console",
      command: "pnpm --filter @llmingress/console exec tsx src/main.ts dev",
    },
  ];

  for (const appCommand of appCommands) {
    const result = spawnSync("bash", ["-lc", appCommand.command], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CONSOLE_PORT: "3101",
        DATABASE_URL: "not-a-url",
        GATEWAY_PORT: "4101abc",
        MASTER_KEY: "test-master-key",
        WORKER_HEARTBEAT_MS: "1500ms",
      },
      timeout: 5000,
    });

    expect(result.error?.message, `${appCommand.name} should exit instead of timing out`).toBe(
      undefined,
    );
    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(
      /DATABASE_URL|GATEWAY_PORT|WORKER_HEARTBEAT_MS/,
    );
  }
});
