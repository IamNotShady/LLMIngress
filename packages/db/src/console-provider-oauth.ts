import { createHash, randomBytes } from "node:crypto";
import { providerUsesDeviceCodeOAuth } from "@llmingress/config/provider-registry";
import {
  completeProviderOAuthConnection,
  createProviderOAuthDevicePendingConnection,
  createProviderOAuthPendingConnection,
  deletePendingProviderOAuthDeviceConnections,
  deleteProviderOAuthConnection,
  listProviderOAuthMetadata,
  type ProviderOAuthMetadata,
  readProviderOAuthPendingConnection,
  readProviderOAuthRuntimeConnection,
  setProviderOAuthConnectionEnabled,
  setProviderOAuthQuotaProbeEnabled,
} from "@llmingress/db/providers";
import {
  buildProviderOAuthAuthorizeUrl,
  exchangeProviderOAuthCode,
  pollProviderOAuthUserCodeToken,
  type ProviderOAuthTokenBlob,
  parseProviderOAuthCallbackInput,
  requestProviderOAuthUserCode,
  revokeProviderOAuthToken,
} from "@llmingress/provider/oauth";
import {
  isSubscriptionProviderKey,
  type SubscriptionProviderKey,
} from "@llmingress/provider/subscription";
import type { EncryptionKeySource } from "@llmingress/security/encryption-key";
import type { EncryptedSecret } from "@llmingress/security/secret-encryption";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { isRecord } from "@llmingress/util";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";
import { listProviders } from "./console-providers.ts";

export type ConsoleProviderOAuthConnection = ProviderOAuthMetadata;

type StartProviderOAuthConnectionInput = {
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  label?: string | null;
  priority?: number;
  providerId: string;
};

type StartProviderOAuthConnectionInputInternal = {
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  label?: string | null;
  priority?: number;
  provider: { id: string; providerKey: SubscriptionProviderKey };
};

export type StartProviderOAuthConnectionResult =
  | {
      authorizeUrl: string;
      connection: ProviderOAuthMetadata;
      flowType: "authorization_code";
    }
  | {
      connection: ProviderOAuthMetadata;
      flowType: "device_code";
      intervalSeconds: number;
      userCode: string;
      verificationUri: string;
    };

export type PollProviderOAuthDeviceAuthorizationResult = {
  id?: string;
  message?: string;
  providerId?: string;
  status: "complete" | "error" | "expired" | "pending";
};

type CompleteProviderOAuthConnectionInput = {
  callbackInput: string;
  databaseUrl?: string;
  label?: string | null;
  encryptionKeySource: EncryptionKeySource;
  priority?: number;
  providerOAuthId: string;
};

type RevokeProviderOAuthConnectionInput = {
  databaseUrl?: string;
  encryptionKeySource: EncryptionKeySource;
  providerOAuthId: string;
};

export function listConsoleProviderOAuthConnections(
  databaseUrl?: string,
): Promise<ConsoleProviderOAuthConnection[]> {
  return listProviderOAuthMetadata(databaseUrl);
}

export async function startProviderOAuthConnection(
  input: StartProviderOAuthConnectionInput,
): Promise<StartProviderOAuthConnectionResult> {
  const provider = (await listProviders(input.databaseUrl)).find(
    (candidate) => candidate.id === input.providerId,
  );
  if (!provider) {
    throw consoleNotFoundError("Provider was not found.", "provider_not_found", {
      providerId: input.providerId,
    });
  }
  const providerKey = provider.providerKey;
  if (provider.providerType !== "subscription" || !isSubscriptionProviderKey(providerKey)) {
    throw consoleValidationError(
      "Provider does not support OAuth subscription connections.",
      "provider_oauth_unsupported",
      { providerId: provider.id },
    );
  }

  if (providerUsesDeviceCodeOAuth(providerKey)) {
    return startProviderOAuthDeviceConnection({
      databaseUrl: input.databaseUrl,
      fetch: input.fetch,
      label: input.label,
      priority: input.priority,
      provider: { id: provider.id, providerKey },
    });
  }

  const pkce = createPkcePair();
  // Claude Code's Anthropic OAuth flow expects state to match the PKCE verifier.
  const pendingState = providerKey === "claude_code" ? pkce.codeVerifier : pkce.state;
  const connection = await createProviderOAuthPendingConnection({
    databaseUrl: input.databaseUrl,
    label: input.label,
    pendingCodeChallenge: pkce.codeChallenge,
    pendingCodeVerifier: pkce.codeVerifier,
    pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    pendingState,
    priority: input.priority,
    providerId: provider.id,
  });

  return {
    authorizeUrl: buildProviderOAuthAuthorizeUrl({
      codeChallenge: pkce.codeChallenge,
      providerKey,
      state: pendingState,
    }),
    connection,
    flowType: "authorization_code",
  };
}

// Device-code start (MiniMax shape). Clears any earlier still-pending device
// attempt for the same provider first (§ one-time dialog semantics), then hits
// the upstream device-code endpoint and persists the user code for polling.
async function startProviderOAuthDeviceConnection(
  input: StartProviderOAuthConnectionInputInternal,
): Promise<StartProviderOAuthConnectionResult> {
  await deletePendingProviderOAuthDeviceConnections({
    databaseUrl: input.databaseUrl,
    providerId: input.provider.id,
  });
  const pkce = createPkcePair();
  const userCode = await requestProviderOAuthUserCode({
    codeChallenge: pkce.codeChallenge,
    fetch: input.fetch,
    providerKey: input.provider.providerKey,
    state: pkce.state,
  });
  const connection = await createProviderOAuthDevicePendingConnection({
    databaseUrl: input.databaseUrl,
    intervalSeconds: userCode.intervalSeconds,
    label: input.label,
    pendingCodeChallenge: pkce.codeChallenge,
    pendingCodeVerifier: pkce.codeVerifier,
    pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    pendingState: pkce.state,
    priority: input.priority,
    providerId: input.provider.id,
    userCode: userCode.userCode,
    verificationUri: userCode.verificationUri,
  });

  return {
    connection,
    flowType: "device_code",
    intervalSeconds: userCode.intervalSeconds,
    userCode: userCode.userCode,
    verificationUri: userCode.verificationUri,
  };
}

export async function pollProviderOAuthDeviceAuthorization(input: {
  databaseUrl?: string;
  encryptionKeySource: EncryptionKeySource;
  fetch?: typeof globalThis.fetch;
  providerOAuthId: string;
}): Promise<PollProviderOAuthDeviceAuthorizationResult> {
  const pending = await readProviderOAuthPendingConnection({
    databaseUrl: input.databaseUrl,
    providerOAuthId: input.providerOAuthId,
  });
  const providerKey = pending.providerKey;
  if (!isSubscriptionProviderKey(providerKey)) {
    throw consoleValidationError(
      "Provider does not support OAuth subscription connections.",
      "provider_oauth_unsupported",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  if (pending.flowType !== "device_code") {
    throw consoleValidationError(
      "OAuth connection is not a device-code authorization.",
      "provider_oauth_not_device",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  if (pending.completedAt) {
    return { id: pending.id, providerId: pending.providerId, status: "complete" };
  }
  if (!pending.pendingCodeVerifier || !pending.pendingUserCode) {
    throw consoleValidationError(
      "OAuth connection is not waiting for authorization.",
      "provider_oauth_not_pending",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  // Expiry is enforced locally so an abandoned code never re-hits upstream.
  if (pending.pendingExpiresAt && pending.pendingExpiresAt.getTime() < Date.now()) {
    return { status: "expired" };
  }

  const poll = await pollProviderOAuthUserCodeToken({
    codeVerifier: pending.pendingCodeVerifier,
    fetch: input.fetch,
    providerKey,
    userCode: pending.pendingUserCode,
  });
  if (poll.status === "pending") {
    return { status: "pending" };
  }
  if (poll.status === "error") {
    return { message: poll.message, status: "error" };
  }

  const encryptedToken = encryptProviderOAuthToken({
    encryptionKeySource: input.encryptionKeySource,
    token: poll.token,
  });
  const completed = await completeProviderOAuthConnection({
    databaseUrl: input.databaseUrl,
    encryptedToken,
    providerOAuthId: pending.id,
    tokenExpiresAt: poll.token.expiresAt === null ? null : new Date(poll.token.expiresAt),
  });
  return { id: completed.id, providerId: completed.providerId, status: "complete" };
}

export async function completeProviderOAuthAuthorization(
  input: CompleteProviderOAuthConnectionInput,
): Promise<ProviderOAuthMetadata> {
  const pending = await readProviderOAuthPendingConnection({
    databaseUrl: input.databaseUrl,
    providerOAuthId: input.providerOAuthId,
  });
  if (!isSubscriptionProviderKey(pending.providerKey)) {
    throw consoleValidationError(
      "Provider does not support OAuth subscription connections.",
      "provider_oauth_unsupported",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  // Device-code rows reuse the PKCE columns but must never be exchanged with the
  // authorization-code grant (they have no pasted callback code).
  if (pending.flowType === "device_code") {
    throw consoleValidationError(
      "OAuth connection uses the device-code flow and cannot be completed with a pasted code.",
      "provider_oauth_device_flow",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  if (!pending.pendingCodeVerifier || !pending.pendingState) {
    throw consoleValidationError(
      "OAuth connection is not waiting for authorization.",
      "provider_oauth_not_pending",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  if (pending.pendingExpiresAt && pending.pendingExpiresAt.getTime() < Date.now()) {
    throw consoleValidationError("OAuth authorization request expired.", "provider_oauth_expired", {
      providerOAuthId: input.providerOAuthId,
    });
  }

  const callback = parseProviderOAuthCallbackInput(input.callbackInput);
  if (callback.state && callback.state !== pending.pendingState) {
    throw consoleValidationError(
      "OAuth callback state did not match.",
      "provider_oauth_state_mismatch",
      { providerOAuthId: input.providerOAuthId },
    );
  }

  const token = await exchangeProviderOAuthCode({
    code: callback.code,
    codeVerifier: pending.pendingCodeVerifier,
    providerKey: pending.providerKey,
  });
  const encryptedToken = encryptProviderOAuthToken({
    encryptionKeySource: input.encryptionKeySource,
    token,
  });

  const completeInput: Parameters<typeof completeProviderOAuthConnection>[0] = {
    databaseUrl: input.databaseUrl,
    encryptedToken,
    providerOAuthId: pending.id,
    tokenExpiresAt: token.expiresAt === null ? null : new Date(token.expiresAt),
  };
  if (Object.hasOwn(input, "label")) {
    completeInput.label = input.label;
  }
  if (input.priority !== undefined) {
    completeInput.priority = input.priority;
  }

  return completeProviderOAuthConnection(completeInput);
}

export async function revokeProviderOAuthConnection(
  input: RevokeProviderOAuthConnectionInput,
): Promise<{ providerId: string }> {
  const connection = await readProviderOAuthRuntimeConnection({
    databaseUrl: input.databaseUrl,
    providerOAuthId: input.providerOAuthId,
  });
  if (!isSubscriptionProviderKey(connection.providerKey)) {
    throw consoleValidationError(
      "Provider does not support OAuth subscription connections.",
      "provider_oauth_unsupported",
      { providerOAuthId: input.providerOAuthId },
    );
  }
  const token = readProviderOAuthTokenBlob(
    createSecretEncryption(input.encryptionKeySource).decrypt(
      readEncryptedSecret(connection.encryptedToken),
    ),
  );
  await revokeProviderOAuthToken({
    accessToken: token.accessToken,
    providerKey: connection.providerKey,
  });
  return deleteProviderOAuthConnection(input);
}

export {
  deleteProviderOAuthConnection,
  setProviderOAuthConnectionEnabled,
  setProviderOAuthQuotaProbeEnabled,
};

function encryptProviderOAuthToken(input: {
  encryptionKeySource: EncryptionKeySource;
  token: ProviderOAuthTokenBlob;
}): EncryptedSecret {
  return createSecretEncryption(input.encryptionKeySource).encrypt(JSON.stringify(input.token));
}

function readEncryptedSecret(value: unknown): EncryptedSecret {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "algorithm" in value &&
    "iv" in value &&
    "ciphertext" in value &&
    "authTag" in value &&
    typeof value.algorithm === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.authTag === "string"
  ) {
    return value as EncryptedSecret;
  }

  throw new Error("Stored provider credential is not a valid encrypted secret.");
}

function readProviderOAuthTokenBlob(value: string): ProviderOAuthTokenBlob {
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
        ...(typeof parsed.resourceUrl === "string" && parsed.resourceUrl.trim()
          ? { resourceUrl: parsed.resourceUrl }
          : {}),
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

function createPkcePair(): { codeChallenge: string; codeVerifier: string; state: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  return { codeChallenge, codeVerifier, state };
}
