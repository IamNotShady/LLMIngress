import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export type MasterKeySource =
  | {
      kind: "inline";
      value: string;
    }
  | {
      kind: "file";
      path: string;
    };

export type MasterKey = {
  keyId: string;
  encryptionKey: Buffer;
};

export function loadMasterKey(source: MasterKeySource): MasterKey {
  const secret = source.kind === "inline" ? source.value : readMasterKeyFile(source.path);
  const normalizedSecret = normalizeMasterKey(secret);
  const material = Buffer.from(normalizedSecret, "utf8");

  return {
    keyId: buildMasterKeyId(material),
    encryptionKey: deriveEncryptionKey(material),
  };
}

function readMasterKeyFile(path: string): string {
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

function normalizeMasterKey(value: string): string {
  if (!value.trim()) {
    throw new Error("Master key is required.");
  }

  return value;
}

function buildMasterKeyId(material: Buffer): string {
  return `mk_${createHash("sha256")
    .update("llmingress:master-key-id:v1")
    .update(material)
    .digest("hex")
    .slice(0, 16)}`;
}

function deriveEncryptionKey(material: Buffer): Buffer {
  return createHmac("sha256", material).update("llmingress:secret-encryption:v1").digest();
}
