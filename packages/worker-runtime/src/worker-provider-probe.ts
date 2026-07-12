import {
  completeProviderOAuthConnection,
  readEnabledCompletedProviderOAuthConnections,
  updateProviderOAuthTestResult,
  withPooledPostgresClient,
} from "@llmingress/db/providers";
import {
  type ConnectivityCheckProvider,
  checkProviderConnectivity,
  type ProviderConnectivityCheckResult,
} from "@llmingress/provider/connectivity";
import { refreshProviderOAuthToken } from "@llmingress/provider/oauth";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import {
  isProviderOAuthTokenExpired,
  readEncryptedSecret,
  readProviderOAuthTokenBlob,
} from "./worker-credential-utils.ts";

type ProviderApiKeyRow = {
  encrypted_key: unknown;
  id: string;
  key_prefix: string;
};

type ProviderApiKeyConnectivityResult = ProviderConnectivityCheckResult & {
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
};

type ProviderOAuthConnectivityResult = ProviderConnectivityCheckResult & {
  providerOAuthId: string;
  providerOAuthLabel: string | null;
};

export type AggregatedProviderConnectivityResult = {
  apiKeyResults: ProviderApiKeyConnectivityResult[];
  checkedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
  ok: boolean;
  oauthResults: ProviderOAuthConnectivityResult[];
  probeModelId: string | null;
  providerId: string;
  providerKey: string;
  requestedProviderApiKeyId?: string;
  retryable: boolean;
  status: "healthy" | "unhealthy";
  statusCode: number | null;
};

export type ProbeProvider = ConnectivityCheckProvider & {
  providerType: "api_key" | "local" | "subscription";
};

export async function probeProvider(input: {
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  masterKeySource: MasterKeySource;
  provider: ProbeProvider;
  requestedProviderApiKeyId?: string;
  timeoutMs?: number;
}): Promise<AggregatedProviderConnectivityResult> {
  const apiKeyResults: ProviderApiKeyConnectivityResult[] = [];
  const oauthResults: ProviderOAuthConnectivityResult[] = [];
  if (input.provider.providerType === "subscription") {
    const connections = await readEnabledProviderOAuthAccessTokens({
      databaseUrl: input.databaseUrl,
      fetch: input.fetch ?? globalThis.fetch,
      masterKeySource: input.masterKeySource,
      providerId: input.provider.id,
    });
    for (const connection of connections) {
      const checkResult = await checkProviderConnectivity({
        apiKey: connection.accessToken,
        fetch: input.fetch,
        provider: input.provider,
        timeoutMs: input.timeoutMs,
      });
      const result = {
        ...checkResult,
        providerOAuthId: connection.id,
        providerOAuthLabel: connection.label,
      };
      oauthResults.push(result);
      await updateProviderOAuthTestResult({
        databaseUrl: input.databaseUrl,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        providerOAuthId: result.providerOAuthId,
        status: result.status,
        testedAt: result.checkedAt,
      });
    }
  } else if (input.provider.providerType === "local") {
    apiKeyResults.push(
      await checkProviderConnectivity({
        apiKey: null,
        fetch: input.fetch,
        provider: input.provider,
        timeoutMs: input.timeoutMs,
      }),
    );
  } else {
    const apiKeys = await readEnabledProviderApiKeys({
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource,
      providerId: input.provider.id,
    });
    for (const apiKey of apiKeys) {
      const checkResult = await checkProviderConnectivity({
        apiKey: apiKey.apiKey,
        fetch: input.fetch,
        provider: input.provider,
        timeoutMs: input.timeoutMs,
      });
      const result = {
        ...checkResult,
        providerApiKeyId: apiKey.id,
        providerApiKeyPrefix: apiKey.keyPrefix,
      };
      apiKeyResults.push(result);
      await updateProviderApiKeyTestResult({ databaseUrl: input.databaseUrl, result });
    }
  }

  return aggregateProviderConnectivityResults({
    apiKeyResults,
    oauthResults,
    provider: input.provider,
    requestedProviderApiKeyId: input.requestedProviderApiKeyId,
  });
}

function aggregateProviderConnectivityResults(input: {
  apiKeyResults: ProviderApiKeyConnectivityResult[];
  oauthResults: ProviderOAuthConnectivityResult[];
  provider: ConnectivityCheckProvider;
  requestedProviderApiKeyId?: string;
}): AggregatedProviderConnectivityResult {
  const credentialResults = [...input.apiKeyResults, ...input.oauthResults];
  const success = credentialResults.find((result) => result.ok);
  const representative = success ?? credentialResults[0];
  const checkedAt = representative?.checkedAt ?? new Date().toISOString();
  return {
    apiKeyResults: input.apiKeyResults,
    checkedAt,
    errorCode: success ? null : (representative?.errorCode ?? "provider_api_key_unavailable"),
    errorMessage: success
      ? null
      : (representative?.errorMessage ??
        "Provider has no enabled credentials for connectivity check."),
    latencyMs: credentialResults.reduce((total, result) => total + result.latencyMs, 0),
    ok: Boolean(success),
    oauthResults: input.oauthResults,
    probeModelId: representative?.probeModelId ?? null,
    providerId: input.provider.id,
    providerKey: input.provider.providerKey,
    requestedProviderApiKeyId: input.requestedProviderApiKeyId,
    retryable: success ? false : credentialResults.some((result) => result.retryable),
    status: success ? "healthy" : "unhealthy",
    statusCode: success ? success.statusCode : (representative?.statusCode ?? null),
  };
}

async function readEnabledProviderApiKeys(input: {
  databaseUrl?: string;
  masterKeySource: MasterKeySource;
  providerId: string;
}): Promise<Array<{ apiKey: string; id: string; keyPrefix: string }>> {
  const stored = await withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderApiKeyRow>(
      `
        select id::text, key_prefix, encrypted_key
        from provider_api_keys
        where provider_id = $1
          and enabled = true
        order by priority, created_at, id
      `,
      [input.providerId],
    );
    return result.rows.map((row) => ({
      encryptedKey: readEncryptedSecret(row.encrypted_key),
      id: row.id,
      keyPrefix: row.key_prefix,
    }));
  });
  const encryption = createSecretEncryption(input.masterKeySource);
  return stored.map((row) => ({
    apiKey: encryption.decrypt(row.encryptedKey),
    id: row.id,
    keyPrefix: row.keyPrefix,
  }));
}

async function readEnabledProviderOAuthAccessTokens(input: {
  databaseUrl?: string;
  fetch: typeof globalThis.fetch;
  masterKeySource: MasterKeySource;
  providerId: string;
}): Promise<Array<{ accessToken: string; id: string; label: string | null }>> {
  const connections = await readEnabledCompletedProviderOAuthConnections({
    databaseUrl: input.databaseUrl,
    providerId: input.providerId,
  });
  const encryption = createSecretEncryption(input.masterKeySource);
  return Promise.all(
    connections.map(async (connection) => {
      let token = readProviderOAuthTokenBlob(
        encryption.decrypt(readEncryptedSecret(connection.encryptedToken)),
      );
      if (isProviderOAuthTokenExpired(token)) {
        if (!token.refreshToken || !isSubscriptionProviderKey(connection.providerKey)) {
          throw new Error("Provider OAuth token expired and cannot be refreshed.");
        }
        token = await refreshProviderOAuthToken({
          fetch: input.fetch,
          providerKey: connection.providerKey,
          refreshToken: token.refreshToken,
        });
        await completeProviderOAuthConnection({
          databaseUrl: input.databaseUrl,
          encryptedToken: encryption.encrypt(JSON.stringify(token)),
          providerOAuthId: connection.id,
          tokenExpiresAt: token.expiresAt === null ? null : new Date(token.expiresAt),
        });
      }
      return { accessToken: token.accessToken, id: connection.id, label: connection.label };
    }),
  );
}

async function updateProviderApiKeyTestResult(input: {
  databaseUrl?: string;
  result: ProviderConnectivityCheckResult & {
    providerApiKeyId: string;
    providerApiKeyPrefix: string;
  };
}): Promise<void> {
  await withPooledPostgresClient(input.databaseUrl, async (client) => {
    await client.query(
      `
        update provider_api_keys
        set last_tested_at = $2::timestamptz,
            last_test_status = $3,
            last_test_error_code = $4,
            last_test_error_message = $5,
            updated_at = now()
        where id = $1
      `,
      [
        input.result.providerApiKeyId,
        input.result.checkedAt,
        input.result.status,
        input.result.errorCode,
        input.result.errorMessage,
      ],
    );
  });
}
