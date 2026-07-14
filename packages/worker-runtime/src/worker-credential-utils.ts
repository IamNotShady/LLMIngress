import type { ProviderOAuthTokenBlob } from "@llmingress/provider/oauth";
import type { MasterKeySource } from "@llmingress/security/master-key";
import type { EncryptedSecret } from "@llmingress/security/secret-encryption";
import { isRecord } from "@llmingress/util";

export function readWorkerMasterKeySource(
  env: Record<string, string | undefined> = process.env,
  purpose: string,
): MasterKeySource {
  const inlineKey = env.MASTER_KEY;
  if (inlineKey?.trim()) {
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.MASTER_KEY_FILE;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error(`MASTER_KEY or MASTER_KEY_FILE is required for ${purpose}.`);
}

export function readEncryptedSecret(value: unknown): EncryptedSecret {
  if (
    isRecord(value) &&
    value.version === 1 &&
    value.algorithm === "aes-256-gcm" &&
    typeof value.keyId === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.authTag === "string"
  ) {
    return value as EncryptedSecret;
  }

  throw new Error("Stored provider credential is not a valid encrypted secret.");
}

export function readProviderOAuthTokenBlob(value: string): ProviderOAuthTokenBlob {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
      return {
        accessToken: parsed.accessToken,
        expiresAt:
          typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)
            ? parsed.expiresAt
            : null,
        refreshToken:
          typeof parsed.refreshToken === "string" && parsed.refreshToken.trim()
            ? parsed.refreshToken
            : null,
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
        tokenType:
          typeof parsed.tokenType === "string" && parsed.tokenType.trim()
            ? parsed.tokenType
            : "Bearer",
      };
    }
  } catch {
    // handled by final throw
  }
  throw new Error("Stored provider OAuth token was not recognized.");
}

export function isProviderOAuthTokenExpired(token: ProviderOAuthTokenBlob): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000;
}
