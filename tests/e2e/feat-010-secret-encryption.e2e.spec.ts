import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { loadBootstrapRuntimeConfig } from "../../packages/config/src/index";
import { createSecretEncryption } from "../../packages/security/src/index";

test("provider secret encrypts decrypts rejects wrong key and hides plaintext", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "llmingress-secret-e2e-"));
  const plaintext = "sk-provider-secret-for-e2e";
  const consoleOutputs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    consoleOutputs.push(args.join(" "));
  };
  console.error = (...args) => {
    consoleOutputs.push(args.join(" "));
  };

  try {
    const masterKeyFile = join(tempDir, "master-key");
    const bootstrapConfig = join(tempDir, "bootstrap.json");
    writeFileSync(masterKeyFile, "e2e-master-key\n", "utf8");
    writeFileSync(
      bootstrapConfig,
      JSON.stringify({
        databaseUrl: "postgresql://postgres:postgres@127.0.0.1:55432/secret_e2e",
        masterKeyFile,
      }),
      "utf8",
    );

    const runtimeConfig = loadBootstrapRuntimeConfig({
      env: {
        LLMINGRESS_BOOTSTRAP_CONFIG: bootstrapConfig,
      },
    });
    const encryption = createSecretEncryption(runtimeConfig.masterKeySource);

    const encrypted = encryption.encrypt(plaintext);

    expect(JSON.stringify(encrypted)).not.toContain(plaintext);
    expect(encrypted.ciphertext).not.toBe(plaintext);
    expect(encryption.decrypt(encrypted)).toBe(plaintext);

    const wrongKeyEncryption = createSecretEncryption({
      kind: "inline",
      value: "different-e2e-master-key",
    });
    expect(() => wrongKeyEncryption.decrypt(encrypted)).toThrow(/Secret decryption failed/);

    expect(consoleOutputs.join("\n")).not.toContain(plaintext);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
