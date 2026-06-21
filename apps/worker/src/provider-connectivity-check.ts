import { withPostgresClient } from "@llmingress/db/client";
import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import {
  type ConnectivityCheckProvider,
  checkProviderConnectivity,
  type ProviderConnectivityCheckResult,
} from "@llmingress/provider/connectivity";
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

type ProviderRow = {
  base_url: string | null;
  display_name: string;
  id: string;
  model_id: string | null;
  provider_key: string;
};

export function createProviderConnectivityCheckJobHandler(
  options: CreateProviderConnectivityCheckJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const payload = readConnectivityCheckPayload(job.payload);
    const provider = await readProvider(options.databaseUrl, payload.providerId);
    const providerApiKey = await readProviderApiKey({
      databaseUrl: options.databaseUrl,
      masterKeySource: options.masterKeySource ?? readWorkerMasterKeySource(),
      providerApiKeyId: payload.providerApiKeyId,
      providerId: provider.id,
    });

    const checkResult = await checkProviderConnectivity({
      apiKey: providerApiKey.apiKey,
      fetch: options.fetch,
      provider,
      timeoutMs: payload.timeoutMs ?? options.timeoutMs,
    });
    const result = {
      ...checkResult,
      providerApiKeyId: providerApiKey.id,
      providerApiKeyPrefix: providerApiKey.keyPrefix,
    };
    await updateProviderApiKeyTestResult({
      databaseUrl: options.databaseUrl,
      result,
    });
    await recordProviderHealthEvent({
      databaseUrl: options.databaseUrl,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      jobId: job.id,
      latencyMs: result.latencyMs,
      metadata: {
        checkedAt: result.checkedAt,
        probeModelId: result.probeModelId,
        providerApiKeyPrefix: result.providerApiKeyPrefix,
        providerKey: result.providerKey,
        retryable: result.retryable,
        statusCode: result.statusCode,
      },
      observedAt: new Date(result.checkedAt),
      providerId: provider.id,
      status: result.ok ? "healthy" : "failed",
      trigger: job.trigger === "manual" ? "manual" : "worker_probe",
    });
    return result;
  };
}

async function readProvider(
  databaseUrl: string,
  providerId: string,
): Promise<ConnectivityCheckProvider> {
  return withPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderRow>(
      `
        select providers.id::text,
               providers.provider_key,
               providers.display_name,
               providers.base_url,
               probe_model.model_id
        from providers
        left join lateral (
          select provider_models.model_id
          from provider_models
          where provider_models.provider_id = providers.id
            and provider_models.availability = 'available'
            and provider_models.deleted_at is null
          order by case
                     when provider_models.model_id ~* '(embedding|image|moderation|tts|whisper|sora|dall|davinci|babbage)'
                       then 1
                     else 0
                   end,
                   random()
          limit 1
        ) probe_model on true
        where providers.id = $1
          and providers.enabled = true
          and providers.deleted_at is null
      `,
      [providerId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Provider was not found.");
    }
    if (!row.base_url) {
      throw new Error("Provider base URL is required for connectivity check.");
    }
    if (!row.model_id) {
      throw new Error("Provider has no available models for connectivity check.");
    }

    return {
      baseUrl: row.base_url,
      displayName: row.display_name,
      id: row.id,
      modelId: row.model_id,
      providerKey: row.provider_key,
    };
  });
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

async function readProviderApiKey(input: {
  databaseUrl: string;
  masterKeySource: MasterKeySource;
  providerApiKeyId?: string;
  providerId: string;
}): Promise<{ apiKey: string; id: string; keyPrefix: string }> {
  const stored = await withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderApiKeyRow>(
      `
        select id::text,
               key_prefix,
               encrypted_key
        from provider_api_keys
        where provider_id = $1
          and enabled = true
          and ($2::uuid is null or id = $2::uuid)
        order by priority asc,
                 created_at asc,
                 id asc
        limit 1
      `,
      [input.providerId, input.providerApiKeyId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Provider API key was not found.");
    }
    return {
      encryptedKey: readEncryptedSecret(row.encrypted_key),
      id: row.id,
      keyPrefix: row.key_prefix,
    };
  });

  return {
    apiKey: createSecretEncryption(input.masterKeySource).decrypt(stored.encryptedKey),
    id: stored.id,
    keyPrefix: stored.keyPrefix,
  };
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
        input.result.ok ? "healthy" : "failed",
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

  throw new Error("Stored provider API key is not a valid encrypted secret.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
