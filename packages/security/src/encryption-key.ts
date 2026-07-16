import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export type EncryptionKeySource =
  | {
      kind: "inline";
      value: string;
    }
  | {
      kind: "file";
      path: string;
    };

export type EncryptionKey = {
  keyId: string;
  encryptionKey: Buffer;
};

export function loadEncryptionKey(source: EncryptionKeySource): EncryptionKey {
  const secret = source.kind === "inline" ? source.value : readEncryptionKeyFile(source.path);
  const normalizedSecret = normalizeEncryptionKey(secret);
  const material = Buffer.from(normalizedSecret, "utf8");

  return {
    keyId: buildEncryptionKeyId(material),
    encryptionKey: deriveEncryptionKey(material),
  };
}

function readEncryptionKeyFile(path: string): string {
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

function normalizeEncryptionKey(value: string): string {
  if (!value.trim()) {
    throw new Error("Encryption key is required.");
  }

  return value;
}

function buildEncryptionKeyId(material: Buffer): string {
  return `mk_${createHash("sha256")
    .update("llmingress:master-key-id:v1")
    .update(material)
    .digest("hex")
    .slice(0, 16)}`;
}

function deriveEncryptionKey(material: Buffer): Buffer {
  return createHmac("sha256", material).update("llmingress:secret-encryption:v1").digest();
}
