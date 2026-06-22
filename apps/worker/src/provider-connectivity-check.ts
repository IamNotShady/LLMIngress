import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import {
  completeProviderOAuthConnection,
  isRemovedProviderKey,
  readEnabledCompletedProviderOAuthConnections,
  updateProviderOAuthTestResult,
  withPostgresClient,
} from "@llmingress/db/providers";
import {
  type ConnectivityCheckProvider,
  checkProviderConnectivity,
  type ProviderConnectivityCheckResult,
  type ProviderProbeModelCandidate,
  selectProviderProbeModel,
} from "@llmingress/provider/connectivity";
import { type ProviderOAuthTokenBlob, refreshProviderOAuthToken } from "@llmingress/provider/oauth";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import type { JobHandler } from "./job-runner.js";

export type {
  ConnectivityCheckProvider,
  ProviderConnectivityCheckResult,
} from "@llmingress/provider/connectivity";
export { checkProviderConnectivity } from "@llmingress/provider/connectivity";

type CreateProviderConnectivityCheckJobHandlerOptions = {
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  masterKeySource?: MasterKeySource;
  timeoutMs?: number;
};

type ConnectivityCheckPayload = {
  providerApiKeyId?: string;
  providerId: string;
  timeoutMs?: number;
};

type ProviderApiKeyRow = {
  encrypted_key: unknown;
  id: string;
  key_prefix: string;
};

type ProviderApiKeyConnectivityResult = ProviderConnectivityCheckResult & {
  providerApiKeyId: string;
  providerApiKeyPrefix: string;
};

type ProviderOAuthConnectivityResult = ProviderConnectivityCheckResult & {
  providerOAuthId: string;
  providerOAuthLabel: string | null;
};

type AggregatedProviderConnectivityResult = {
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

type ProviderRow = {
  base_url: string | null;
  display_name: string;
  id: string;
  provider_key: string;
  provider_type: "api_key" | "local" | "subscription";
};

type WorkerConnectivityProvider = ConnectivityCheckProvider & {
  provider_type: ProviderRow["provider_type"];
};

type ProviderModelRow = {
  context_window: number | null;
  input_usd_per_million_tokens: string | null;
  model_id: string;
  output_usd_per_million_tokens: string | null;
};

export function createProviderConnectivityCheckJobHandler(
  options: CreateProviderConnectivityCheckJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const payload = readConnectivityCheckPayload(job.payload);
    const provider = await readProvider(options.databaseUrl, payload.providerId);
    const masterKeySource = options.masterKeySource ?? readWorkerMasterKeySource();
    const apiKeyResults: ProviderApiKeyConnectivityResult[] = [];
    const oauthResults: ProviderOAuthConnectivityResult[] = [];
    if (provider.provider_type === "subscription") {
      const providerOAuthConnections = await readEnabledProviderOAuthAccessTokens({
        databaseUrl: options.databaseUrl,
        fetch: options.fetch ?? globalThis.fetch,
        masterKeySource,
        providerId: provider.id,
      });
      for (const connection of providerOAuthConnections) {
        const checkResult = await checkProviderConnectivity({
          apiKey: connection.accessToken,
          fetch: options.fetch,
          provider,
          timeoutMs: payload.timeoutMs ?? options.timeoutMs,
        });
        const oauthResult = {
          ...checkResult,
          providerOAuthId: connection.id,
          providerOAuthLabel: connection.label,
        };
        oauthResults.push(oauthResult);
        await updateProviderOAuthTestResult({
          databaseUrl: options.databaseUrl,
          errorCode: oauthResult.errorCode,
          errorMessage: oauthResult.errorMessage,
          providerOAuthId: oauthResult.providerOAuthId,
          status: oauthResult.status,
          testedAt: oauthResult.checkedAt,
        });
      }
    } else {
      const providerApiKeys = await readEnabledProviderApiKeys({
        databaseUrl: options.databaseUrl,
        masterKeySource,
        providerId: provider.id,
      });
      for (const providerApiKey of providerApiKeys) {
        const checkResult = await checkProviderConnectivity({
          apiKey: providerApiKey.apiKey,
          fetch: options.fetch,
          provider,
          timeoutMs: payload.timeoutMs ?? options.timeoutMs,
        });
        const apiKeyResult = {
          ...checkResult,
          providerApiKeyId: providerApiKey.id,
          providerApiKeyPrefix: providerApiKey.keyPrefix,
        };
        apiKeyResults.push(apiKeyResult);
        await updateProviderApiKeyTestResult({
          databaseUrl: options.databaseUrl,
          result: apiKeyResult,
        });
      }
    }
    const result = aggregateProviderConnectivityResults({
      apiKeyResults,
      oauthResults,
      provider,
      requestedProviderApiKeyId: payload.providerApiKeyId,
    });
    await recordProviderHealthEvent({
      databaseUrl: options.databaseUrl,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      jobId: job.id,
      latencyMs: result.latencyMs,
      metadata: {
        checkedAt: result.checkedAt,
        apiKeyResults: result.apiKeyResults.map((apiKeyResult) => ({
          errorCode: apiKeyResult.errorCode,
          ok: apiKeyResult.ok,
          probeModelId: apiKeyResult.probeModelId,
          providerApiKeyPrefix: apiKeyResult.providerApiKeyPrefix,
          retryable: apiKeyResult.retryable,
          status: apiKeyResult.status,
          statusCode: apiKeyResult.statusCode,
        })),
        oauthResults: result.oauthResults.map((oauthResult) => ({
          errorCode: oauthResult.errorCode,
          ok: oauthResult.ok,
          probeModelId: oauthResult.probeModelId,
          providerOAuthId: oauthResult.providerOAuthId,
          providerOAuthLabel: oauthResult.providerOAuthLabel,
          retryable: oauthResult.retryable,
          status: oauthResult.status,
          statusCode: oauthResult.statusCode,
        })),
        probeModelId: result.probeModelId,
        providerKey: result.providerKey,
        requestedProviderApiKeyId: result.requestedProviderApiKeyId,
        retryable: result.retryable,
        statusCode: result.statusCode,
      },
      observedAt: new Date(result.checkedAt),
      providerId: provider.id,
      status: result.status,
      trigger: job.trigger === "manual" ? "manual" : "worker_probe",
    });
    return result;
  };
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

async function readProvider(
  databaseUrl: string,
  providerId: string,
): Promise<WorkerConnectivityProvider> {
  return withPostgresClient(databaseUrl, async (client) => {
    const providerResult = await client.query<ProviderRow>(
      `
        select providers.id::text,
               providers.provider_key,
               providers.display_name,
               providers.provider_type,
               providers.base_url
        from providers
        where providers.id = $1
          and providers.enabled = true
          and providers.deleted_at is null
      `,
      [providerId],
    );
    const row = providerResult.rows[0];
    if (!row) {
      throw new Error("Provider was not found.");
    }
    if (!row.base_url) {
      throw new Error("Provider base URL is required for connectivity check.");
    }
    if (isRemovedProviderKey(row.provider_key)) {
      throw new Error("Provider is no longer supported.");
    }

    const modelResult = await client.query<ProviderModelRow>(
      `
        select model_id,
               context_window,
               coalesce(
                 manual_input_usd_per_million_tokens,
                 synced_input_usd_per_million_tokens
               )::text as input_usd_per_million_tokens,
               coalesce(
                 manual_output_usd_per_million_tokens,
                 synced_output_usd_per_million_tokens
               )::text as output_usd_per_million_tokens
        from provider_models
        where provider_id = $1
          and availability = 'available'
          and deleted_at is null
          and context_window is not null
      `,
      [providerId],
    );
    const modelId = selectProviderProbeModel(modelResult.rows.map(toProbeModelCandidate));
    if (!modelId) {
      throw new Error("Provider has no ordinary chat-compatible models for connectivity check.");
    }

    return {
      baseUrl: row.base_url,
      displayName: row.display_name,
      id: row.id,
      modelId,
      providerKey: row.provider_key,
      provider_type: row.provider_type,
    };
  });
}

function toProbeModelCandidate(row: ProviderModelRow): ProviderProbeModelCandidate {
  return {
    contextWindow: row.context_window,
    inputUsdPerMillionTokens: row.input_usd_per_million_tokens,
    modelId: row.model_id,
    outputUsdPerMillionTokens: row.output_usd_per_million_tokens,
  };
}

function readConnectivityCheckPayload(payload: unknown): ConnectivityCheckPayload {
  if (!isRecord(payload)) {
    throw new Error("provider_connectivity_check job payload is required.");
  }
  if (typeof payload.providerId !== "string" || !payload.providerId.trim()) {
    throw new Error("provider_connectivity_check job payload requires providerId.");
  }
  if (payload.providerApiKeyId !== undefined && typeof payload.providerApiKeyId !== "string") {
    throw new Error("provider_connectivity_check job payload providerApiKeyId must be a string.");
  }

  return {
    providerApiKeyId: payload.providerApiKeyId?.trim() || undefined,
    providerId: payload.providerId,
    timeoutMs:
      typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
        ? payload.timeoutMs
        : undefined,
  };
}

async function readEnabledProviderApiKeys(input: {
  databaseUrl: string;
  masterKeySource: MasterKeySource;
  providerId: string;
}): Promise<Array<{ apiKey: string; id: string; keyPrefix: string }>> {
  const stored = await withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderApiKeyRow>(
      `
        select id::text,
               key_prefix,
               encrypted_key
        from provider_api_keys
        where provider_id = $1
          and enabled = true
        order by priority asc,
                 created_at asc,
                 id asc
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
  databaseUrl: string;
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
      let token = readOAuthTokenBlob(
        encryption.decrypt(readEncryptedSecret(connection.encryptedToken)),
      );
      if (isOAuthTokenExpired(token)) {
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

      return {
        accessToken: token.accessToken,
        id: connection.id,
        label: connection.label,
      };
    }),
  );
}

async function updateProviderApiKeyTestResult(input: {
  databaseUrl: string;
  result: ProviderConnectivityCheckResult & {
    providerApiKeyId: string;
    providerApiKeyPrefix: string;
  };
}): Promise<void> {
  await withPostgresClient(input.databaseUrl, async (client) => {
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

export function readWorkerMasterKeySource(
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

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required for provider connectivity checks.");
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

function readOAuthTokenBlob(value: string): ProviderOAuthTokenBlob {
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

function isOAuthTokenExpired(token: ProviderOAuthTokenBlob): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
