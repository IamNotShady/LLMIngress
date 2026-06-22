import { createHash, randomBytes } from "node:crypto";
import {
  completeProviderOAuthConnection,
  createProviderOAuthPendingConnection,
  deleteProviderOAuthConnection,
  listProviderOAuthMetadata,
  type ProviderOAuthMetadata,
  readProviderOAuthPendingConnection,
  setProviderOAuthConnectionEnabled,
} from "@llmingress/db/providers";
import {
  buildProviderOAuthAuthorizeUrl,
  exchangeProviderOAuthCode,
  type ProviderOAuthTokenBlob,
  parseProviderOAuthCallbackInput,
} from "@llmingress/provider/oauth";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import type { EncryptedSecret } from "@llmingress/security/secret-encryption";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { listProviders } from "./providers";

export type ConsoleProviderOAuthConnection = ProviderOAuthMetadata;

type StartProviderOAuthConnectionInput = {
  databaseUrl: string;
  label?: string | null;
  priority?: number;
  providerId: string;
};

type StartProviderOAuthConnectionResult = {
  authorizeUrl: string;
  connection: ProviderOAuthMetadata;
};

type CompleteProviderOAuthConnectionInput = {
  callbackInput: string;
  databaseUrl: string;
  label?: string | null;
  masterKeySource: MasterKeySource;
  priority?: number;
  providerOAuthId: string;
};

export function listConsoleProviderOAuthConnections(
  databaseUrl: string,
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
    throw new Error("Provider was not found.");
  }
  if (
    provider.providerType !== "subscription" ||
    !isSubscriptionProviderKey(provider.providerKey)
  ) {
    throw new Error("Provider does not support OAuth subscription connections.");
  }

  const pkce = createPkcePair();
  // Claude Code's Anthropic OAuth flow expects state to match the PKCE verifier.
  const pendingState = provider.providerKey === "claude_code" ? pkce.codeVerifier : pkce.state;
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
      providerKey: provider.providerKey,
      state: pendingState,
    }),
    connection,
  };
}

export async function completeProviderOAuthAuthorization(
  input: CompleteProviderOAuthConnectionInput,
): Promise<ProviderOAuthMetadata> {
  const pending = await readProviderOAuthPendingConnection({
    databaseUrl: input.databaseUrl,
    providerOAuthId: input.providerOAuthId,
  });
  if (!isSubscriptionProviderKey(pending.providerKey)) {
    throw new Error("Provider does not support OAuth subscription connections.");
  }
  if (!pending.pendingCodeVerifier || !pending.pendingState) {
    throw new Error("OAuth connection is not waiting for authorization.");
  }
  if (pending.pendingExpiresAt && pending.pendingExpiresAt.getTime() < Date.now()) {
    throw new Error("OAuth authorization request expired.");
  }

  const callback = parseProviderOAuthCallbackInput(input.callbackInput);
  if (callback.state && callback.state !== pending.pendingState) {
    throw new Error("OAuth callback state did not match.");
  }

  const token = await exchangeProviderOAuthCode({
    code: callback.code,
    codeVerifier: pending.pendingCodeVerifier,
    providerKey: pending.providerKey,
  });
  const encryptedToken = encryptProviderOAuthToken({
    masterKeySource: input.masterKeySource,
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

export { deleteProviderOAuthConnection, setProviderOAuthConnectionEnabled };

function encryptProviderOAuthToken(input: {
  masterKeySource: MasterKeySource;
  token: ProviderOAuthTokenBlob;
}): EncryptedSecret {
  return createSecretEncryption(input.masterKeySource).encrypt(JSON.stringify(input.token));
}

function createPkcePair(): { codeChallenge: string; codeVerifier: string; state: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  return { codeChallenge, codeVerifier, state };
}
