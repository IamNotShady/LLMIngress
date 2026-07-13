import {
  getPostgresPool,
  withPooledPostgresClient,
  withPostgresTransaction,
} from "@llmingress/db/client";
import { readEnabledCompletedProviderOAuthConnections } from "@llmingress/db/providers";
import {
  type ProviderOAuthTokenBlob,
  refreshProviderOAuthToken as refreshProviderOAuthTokenRequest,
} from "@llmingress/provider/oauth";
import {
  isSubscriptionProviderKey,
  type SubscriptionProviderKey,
} from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { isRecord } from "@llmingress/util";
import { runGatewayBackgroundTask } from "./gateway-background-tasks.ts";
import type { GatewayRouteCandidateSnapshot } from "./gateway-config-reload.ts";
import { GatewayPipelineError } from "./gateway-errors.ts";
import type { FallbackChainCandidate, FallbackProviderApiKey } from "./gateway-fallback-chain.ts";

type ProviderCredentialRow = {
  base_url: string | null;
  encrypted_key: unknown;
  key_prefix: string;
  provider_api_key_id: string;
  provider_id: string;
};

type ProviderCredentialProviderRow = {
  base_url: string | null;
  provider_id: string;
  provider_key: string;
  provider_type: "api_key" | "local" | "subscription";
};

type ProviderCredentials = {
  baseUrl: string;
  keys: FallbackProviderApiKey[];
};

type ProviderOAuthTokenRefresh = (input: {
  providerKey: SubscriptionProviderKey;
  refreshToken: string;
}) => Promise<ProviderOAuthTokenBlob>;

type ProviderCredentialOAuthLockRow = {
  encrypted_token: unknown;
};

export async function attachGatewayProviderCredentials(input: {
  candidates: readonly GatewayRouteCandidateSnapshot[];
  databaseUrl?: string;
  masterKeySource: MasterKeySource;
  refreshProviderOAuthToken?: ProviderOAuthTokenRefresh;
}): Promise<FallbackChainCandidate[]> {
  const providerIds = [...new Set(input.candidates.map((candidate) => candidate.providerId))];
  const credentials = await readProviderCredentials({
    databaseUrl: input.databaseUrl,
    masterKeySource: input.masterKeySource,
    providerIds,
    refreshProviderOAuthToken: input.refreshProviderOAuthToken,
  });

  return input.candidates.map((candidate) => {
    const credential = credentials.get(candidate.providerId);
    if (!credential) {
      throw new GatewayPipelineError(
        "provider_credentials_missing",
        `Provider credentials are missing for provider ${candidate.providerId}.`,
      );
    }
    const primaryKey = credential.keys[0];
    if (!primaryKey) {
      throw new GatewayPipelineError(
        "provider_credentials_missing",
        `Provider credentials are missing for provider ${candidate.providerId}.`,
      );
    }

    return {
      ...candidate,
      apiKey: primaryKey.apiKey,
      baseUrl: credential.baseUrl,
      providerApiKeyId: primaryKey.providerApiKeyId,
      providerApiKeyPrefix: primaryKey.keyPrefix,
      providerApiKeys: credential.keys,
    };
  });
}

export async function attachGatewayProviderCredentialsLeniently(input: {
  candidates: readonly GatewayRouteCandidateSnapshot[];
  databaseUrl?: string;
  masterKeySource: MasterKeySource;
  refreshProviderOAuthToken?: ProviderOAuthTokenRefresh;
}): Promise<FallbackChainCandidate[]> {
  const attached: FallbackChainCandidate[] = [];
  for (const candidate of input.candidates) {
    try {
      attached.push(
        ...(await attachGatewayProviderCredentials({
          ...input,
          candidates: [candidate],
        })),
      );
    } catch {
      // Missing credentials or provider base URL for one candidate should not abort fallback.
    }
  }
  if (attached.length === 0) {
    throw new GatewayPipelineError(
      "provider_credentials_missing",
      "Provider credentials are not configured for any candidate on the selected route.",
    );
  }
  return attached;
}

export function readGatewayMasterKeySource(
  env: Record<string, string | undefined> = process.env,
): MasterKeySource {
  const inlineKey = env.MASTER_KEY;
  if (inlineKey?.trim()) {
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.MASTER_KEY_FILE;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required for Gateway provider calls.");
}

async function readProviderCredentials(input: {
  databaseUrl?: string;
  masterKeySource: MasterKeySource;
  providerIds: string[];
  refreshProviderOAuthToken?: ProviderOAuthTokenRefresh;
}): Promise<Map<string, ProviderCredentials>> {
  if (input.providerIds.length === 0) {
    return new Map();
  }

  const encryption = createSecretEncryption(input.masterKeySource);
  const { apiKeyRows, providerRows } = await withPooledPostgresClient(
    input.databaseUrl,
    async (client) => {
      const providerResult = await client.query<ProviderCredentialProviderRow>(
        `
          select id::text as provider_id,
                 provider_type,
                 provider_key,
                 base_url
          from providers
          where id = any($1::uuid[])
            and enabled = true
            and deleted_at is null
        `,
        [input.providerIds],
      );

      const apiKeyResult = await client.query<ProviderCredentialRow>(
        `
          select providers.id::text as provider_id,
                 providers.base_url,
                 provider_api_keys.id::text as provider_api_key_id,
                 provider_api_keys.key_prefix,
                 provider_api_keys.encrypted_key
          from providers
          join provider_api_keys on provider_api_keys.provider_id = providers.id
          where providers.id = any($1::uuid[])
            and providers.enabled = true
            and providers.deleted_at is null
            and providers.provider_type = 'api_key'
            and provider_api_keys.enabled = true
          order by providers.id,
                   provider_api_keys.priority asc,
                   provider_api_keys.created_at asc,
                   provider_api_keys.id asc
        `,
        [input.providerIds],
      );

      return {
        apiKeyRows: apiKeyResult.rows,
        providerRows: providerResult.rows,
      };
    },
  );

  const credentials = new Map<string, ProviderCredentials>();
  for (const row of providerRows) {
    if (!row.base_url?.trim()) {
      throw new Error(`Provider base URL is missing for provider ${row.provider_id}.`);
    }
    credentials.set(row.provider_id, {
      baseUrl: row.base_url,
      keys: row.provider_type === "local" ? [{ apiKey: "" }] : [],
    });
  }

  for (const row of apiKeyRows) {
    if (!row.base_url?.trim()) {
      throw new Error(`Provider base URL is missing for provider ${row.provider_id}.`);
    }

    const existing = credentials.get(row.provider_id);
    const providerCredentials = existing ?? { baseUrl: row.base_url, keys: [] };
    providerCredentials.keys.push({
      apiKey: encryption.decrypt(readEncryptedSecret(row.encrypted_key)),
      credentialKind: "api_key",
      keyPrefix: row.key_prefix,
      providerApiKeyId: row.provider_api_key_id,
    });
    credentials.set(row.provider_id, providerCredentials);
  }

  const refresh = input.refreshProviderOAuthToken ?? refreshProviderOAuthTokenRequest;
  for (const provider of providerRows) {
    if (provider.provider_type !== "subscription") {
      continue;
    }
    const providerCredentials = credentials.get(provider.provider_id);
    if (!providerCredentials || !isSubscriptionProviderKey(provider.provider_key)) {
      continue;
    }
    const connections = await readEnabledCompletedProviderOAuthConnections({
      databaseUrl: input.databaseUrl,
      providerId: provider.provider_id,
    });
    for (const connection of connections) {
      let token = readProviderOAuthTokenBlob(
        encryption.decrypt(readEncryptedSecret(connection.encryptedToken)),
      );
      if (isProviderOAuthTokenExpired(token)) {
        if (!token.refreshToken) {
          continue;
        }
        token = await refreshProviderOAuthTokenWithLock({
          databaseUrl: input.databaseUrl,
          encryption,
          providerKey: provider.provider_key,
          providerOAuthId: connection.id,
          refresh,
        });
      }
      providerCredentials.keys.push({
        apiKey: token.accessToken,
        credentialKind: "oauth",
        providerOAuthId: connection.id,
      });
    }
  }

  return credentials;
}

export async function refreshProviderOAuthTokenWithLock(input: {
  databaseUrl?: string;
  encryption: ReturnType<typeof createSecretEncryption>;
  providerKey: SubscriptionProviderKey;
  providerOAuthId: string;
  refresh: (input: {
    providerKey: SubscriptionProviderKey;
    refreshToken: string;
  }) => Promise<ProviderOAuthTokenBlob>;
}): Promise<ProviderOAuthTokenBlob> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderCredentialOAuthLockRow>(
      `
        select encrypted_token
        from provider_oauth
        where id = $1
        for update
      `,
      [input.providerOAuthId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new GatewayPipelineError(
        "provider_credentials_missing",
        "Provider OAuth connection is missing.",
      );
    }

    const current = readProviderOAuthTokenBlob(
      input.encryption.decrypt(readEncryptedSecret(row.encrypted_token)),
    );
    if (!isProviderOAuthTokenExpired(current)) {
      return current;
    }
    if (!current.refreshToken) {
      throw new GatewayPipelineError(
        "provider_credentials_missing",
        "Provider OAuth token expired without a refresh token.",
      );
    }

    const refreshed = await input.refresh({
      providerKey: input.providerKey,
      refreshToken: current.refreshToken,
    });
    await client.query(
      `
        update provider_oauth
        set encrypted_token = $2,
            token_expires_at = $3,
            updated_at = now()
        where id = $1
      `,
      [
        input.providerOAuthId,
        JSON.stringify(input.encryption.encrypt(JSON.stringify(refreshed))),
        refreshed.expiresAt === null ? null : new Date(refreshed.expiresAt),
      ],
    );
    return refreshed;
  });
}

export function recordGatewayProviderApiKeyLastUsed(input: {
  databaseUrl?: string;
  providerApiKeyId?: string;
}): void {
  if (!input.providerApiKeyId) {
    return;
  }

  runGatewayBackgroundTask({
    message: "gateway provider api key last-used recording failed",
    metadata: { providerApiKeyId: input.providerApiKeyId },
    name: "gateway.provider_api_key.last_used",
    task: async () => {
      await getPostgresPool(input.databaseUrl).query(
        `
          update provider_api_keys
          set last_used_at = now(),
              updated_at = now()
          where id = $1
        `,
        [input.providerApiKeyId],
      );
    },
  });
}

function readEncryptedSecret(value: unknown): EncryptedSecret {
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

function isProviderOAuthTokenExpired(token: ProviderOAuthTokenBlob): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000;
}
