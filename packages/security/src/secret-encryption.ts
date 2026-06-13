import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadMasterKey, type MasterKey, type MasterKeySource } from "./master-key.js";

export type EncryptedSecret = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export type SecretEncryptionService = {
  keyId: string;
  encrypt: (plaintext: string) => EncryptedSecret;
  decrypt: (encrypted: EncryptedSecret) => string;
};

export function createSecretEncryption(source: MasterKeySource): SecretEncryptionService {
  const masterKey = loadMasterKey(source);

  return {
    keyId: masterKey.keyId,
    encrypt: (plaintext: string) => encryptSecret(plaintext, masterKey),
    decrypt: (encrypted: EncryptedSecret) => decryptSecret(encrypted, masterKey),
  };
}

export function encryptSecret(plaintext: string, masterKey: MasterKey): EncryptedSecret {
  if (!plaintext) {
    throw new Error("Secret plaintext is required.");
  }

  const iv = randomBytes(12);
  const aad = buildAdditionalAuthenticatedData(masterKey.keyId);
  const cipher = createCipheriv("aes-256-gcm", masterKey.encryptionKey, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: masterKey.keyId,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptSecret(encrypted: EncryptedSecret, masterKey: MasterKey): string {
  try {
    if (
      encrypted.version !== 1 ||
      encrypted.algorithm !== "aes-256-gcm" ||
      encrypted.keyId !== masterKey.keyId
    ) {
      throw new Error("Unsupported encrypted secret.");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKey.encryptionKey,
      Buffer.from(encrypted.iv, "base64url"),
    );
    decipher.setAAD(buildAdditionalAuthenticatedData(encrypted.keyId));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Secret decryption failed.");
  }
}

function buildAdditionalAuthenticatedData(keyId: string): Buffer {
  return Buffer.from(`llmingress:secret:v1:${keyId}`, "utf8");
}
