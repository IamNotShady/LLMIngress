import { describe, expect, it } from "vitest";
import { loadBootstrapRuntimeConfig } from "../../packages/config/src/index";

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
});
