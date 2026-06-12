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
