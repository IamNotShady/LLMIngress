import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBootstrapConfigFile } from "../../packages/config/src/index.ts";
import { readPostgresDatabaseUrl } from "../../packages/db/src/client.ts";

function writeTempConfig(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "arch-hardening-")), "bootstrap.json");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("console error boundaries", () => {
  it("uses zod at the bootstrap boundary", () => {
    expect(readFileSync("packages/config/src/index.ts", "utf8")).toContain('from "zod"');
  });

  it("rejects a bootstrap config file with wrongly typed fields", () => {
    const path = writeTempConfig('{ "encryptionKey": 123 }');
    expect(() => readBootstrapConfigFile(path)).toThrow(
      /LLMINGRESS_BOOTSTRAP_CONFIG could not be read/,
    );
  });

  it("lets the database URL reader ignore unrelated malformed bootstrap fields", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:55432/postgres";
    const path = writeTempConfig(
      JSON.stringify({
        databaseUrl,
        gatewayPort: null,
        encryptionKey: 12345,
      }),
    );

    expect(readPostgresDatabaseUrl({ configFilePath: path, env: {} })).toBe(databaseUrl);
    expect(() => readBootstrapConfigFile(path)).toThrow(
      /LLMINGRESS_BOOTSTRAP_CONFIG could not be read/,
    );
  });

  it("accepts a valid bootstrap config file", () => {
    const path = writeTempConfig('{ "gatewayPort": 4100, "encryptionKey": "k" }');
    expect(readBootstrapConfigFile(path)).toMatchObject({ gatewayPort: 4100, encryptionKey: "k" });
  });
});
