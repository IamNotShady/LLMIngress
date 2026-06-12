import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBootstrapRuntimeConfig } from "../../packages/config/src/index";

const root = resolve(import.meta.dirname, "../..");

describe("feat-006 bootstrap runtime configuration", () => {
  it("loads ports database url and inline master key from environment", () => {
    const config = loadBootstrapRuntimeConfig({
      env: {
        GATEWAY_PORT: "4100",
        CONSOLE_PORT: "3100",
        WORKER_HEARTBEAT_MS: "1500",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
        MASTER_KEY: "test-master-key",
      },
    });

    expect(config).toEqual({
      gatewayPort: 4100,
      consolePort: 3100,
      workerHeartbeatMs: 1500,
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:55432/app",
      masterKeySource: { kind: "inline", value: "test-master-key" },
    });
  });

  it("uses stable local defaults for optional ports and heartbeat", () => {
    const config = loadBootstrapRuntimeConfig({
      env: {
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
        MASTER_KEY_FILE: "/tmp/llmingress-master-key",
      },
    });

    expect(config.gatewayPort).toBe(4000);
    expect(config.consolePort).toBe(3000);
    expect(config.workerHeartbeatMs).toBe(30_000);
    expect(config.masterKeySource).toEqual({
      kind: "file",
      path: "/tmp/llmingress-master-key",
    });
  });

  it("rejects invalid required values with clear errors", () => {
    expect(() =>
      loadBootstrapRuntimeConfig({
        env: {
          GATEWAY_PORT: "not-a-port",
          DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
          MASTER_KEY: "test-master-key",
        },
      }),
    ).toThrow(/GATEWAY_PORT/);

    expect(() => loadBootstrapRuntimeConfig({ env: { MASTER_KEY: "test-master-key" } })).toThrow(
      /DATABASE_URL/,
    );

    expect(() =>
      loadBootstrapRuntimeConfig({
        env: { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app" },
      }),
    ).toThrow(/MASTER_KEY/);
  });

  it("rejects integers with trailing garbage", () => {
    expect(() =>
      loadBootstrapRuntimeConfig({
        env: {
          GATEWAY_PORT: "4101abc",
          DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
          MASTER_KEY: "test-master-key",
        },
      }),
    ).toThrow(/GATEWAY_PORT/);

    expect(() =>
      loadBootstrapRuntimeConfig({
        env: {
          WORKER_HEARTBEAT_MS: "1500ms",
          DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
          MASTER_KEY: "test-master-key",
        },
      }),
    ).toThrow(/WORKER_HEARTBEAT_MS/);
  });

  it("wires the bootstrap loader into every app startup entrypoint", () => {
    const gatewayMain = readFileSync(resolve(root, "apps/gateway/src/main.ts"), "utf8");
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");
    const consoleMainPath = resolve(root, "apps/console/src/main.ts");
    const consolePackage = readFileSync(resolve(root, "apps/console/package.json"), "utf8");

    expect(gatewayMain).toContain("@llmingress/config");
    expect(gatewayMain).toContain("loadBootstrapRuntimeConfig");
    expect(workerMain).toContain("@llmingress/config");
    expect(workerMain).toContain("loadBootstrapRuntimeConfig");
    expect(existsSync(consoleMainPath)).toBe(true);
    expect(readFileSync(consoleMainPath, "utf8")).toContain("loadBootstrapRuntimeConfig");
    expect(JSON.parse(consolePackage).scripts.dev).toBe("tsx src/main.ts dev");
    expect(JSON.parse(consolePackage).scripts.start).toBe("tsx src/main.ts start");
  });
});
