import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSecretEncryption,
  decryptSecret,
  encryptSecret,
  loadMasterKey,
} from "../../packages/security/src/index";

describe("feat-010 master key and secret encryption", () => {
  it("encrypts to non-plaintext ciphertext and decrypts with the same master key", () => {
    const plaintext = "sk-test-provider-secret";
    const masterKey = loadMasterKey({ kind: "inline", value: "unit-test-master-key" });

    const encrypted = encryptSecret(plaintext, masterKey);

    expect(encrypted).toMatchObject({
      algorithm: "aes-256-gcm",
      version: 1,
      keyId: masterKey.keyId,
    });
    expect(encrypted.ciphertext).not.toBe(plaintext);
    expect(JSON.stringify(encrypted)).not.toContain(plaintext);
    expect(decryptSecret(encrypted, masterKey)).toBe(plaintext);
  });

  it("rejects decryption with a different master key", () => {
    const encrypted = encryptSecret(
      "sk-test-provider-secret",
      loadMasterKey({ kind: "inline", value: "correct-master-key" }),
    );

    expect(() =>
      decryptSecret(encrypted, loadMasterKey({ kind: "inline", value: "wrong-master-key" })),
    ).toThrow(/Secret decryption failed/);
  });

  it("loads a file-backed master key and trims the common trailing newline", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llmingress-secret-unit-"));

    try {
      const masterKeyFile = join(tempDir, "master-key");
      writeFileSync(masterKeyFile, "file-backed-master-key\n", "utf8");

      const service = createSecretEncryption({
        kind: "file",
        path: masterKeyFile,
      });
      const encrypted = service.encrypt("sk-file-secret");

      expect(encrypted.keyId).toBe(
        loadMasterKey({ kind: "inline", value: "file-backed-master-key" }).keyId,
      );
      expect(service.decrypt(encrypted)).toBe("sk-file-secret");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not write plaintext secrets to console output", () => {
    const plaintext = "sk-secret-that-must-not-be-logged";
    const outputs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      outputs.push(args.join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      outputs.push(args.join(" "));
    });

    try {
      const service = createSecretEncryption({
        kind: "inline",
        value: "logging-test-master-key",
      });
      const encrypted = service.encrypt(plaintext);
      expect(service.decrypt(encrypted)).toBe(plaintext);

      expect(outputs.join("\n")).not.toContain(plaintext);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
