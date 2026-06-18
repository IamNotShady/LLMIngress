import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { Client, type QueryResultRow } from "pg";
import type { JobHandler } from "./job-runner.js";

export type ConnectivityCheckProvider = {
  baseUrl: string;
  displayName: string;
  id: string;
  providerKey: string;
};

export type ProviderConnectivityCheckResult = {
  checkedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
  ok: boolean;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerId: string;
  providerKey: string;
  retryable: boolean;
  status: "healthy" | "failed";
  statusCode: number | null;
};

type CreateProviderConnectivityCheckJobHandlerOptions = {
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  masterKeySource?: MasterKeySource;
  timeoutMs?: number;
};

type CheckProviderConnectivityOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  provider: ConnectivityCheckProvider;
  timeoutMs?: number;
};

type ConnectivityCheckPayload = {
  providerApiKeyId?: string;
  providerId: string;
  timeoutMs?: number;
};

type ProviderApiKeyRow = QueryResultRow & {
  encrypted_key: unknown;
  id: string;
  key_prefix: string;
};

type ProviderRow = QueryResultRow & {
  base_url: string | null;
  display_name: string;
  id: string;
  provider_key: string;
};

const defaultTimeoutMs = 5_000;
const timeoutErrorMessage = "Provider connectivity check timed out.";

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

export async function checkProviderConnectivity(
  options: CheckProviderConnectivityOptions,
): Promise<ProviderConnectivityCheckResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const startedAt = nowMs();
  const checkedAt = new Date(startedAt).toISOString();

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      buildChatCompletionsUrl(options.provider.baseUrl),
      {
        body: JSON.stringify({
          max_tokens: 1,
          messages: [{ content: "ping", role: "user" }],
          model: "connectivity-check",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
      timeoutMs,
    );
    const body = await readResponseBody(response);
    const latencyMs = Math.max(0, nowMs() - startedAt);

    if (!response.ok) {
      const error = readProviderError(body);
      return {
        checkedAt,
        errorCode: error.code,
        errorMessage: error.message,
        latencyMs,
        ok: false,
        providerId: options.provider.id,
        providerKey: options.provider.providerKey,
        retryable: response.status === 429 || response.status >= 500,
        status: "failed",
        statusCode: response.status,
      };
    }

    return {
      checkedAt,
      errorCode: null,
      errorMessage: null,
      latencyMs,
      ok: true,
      providerId: options.provider.id,
      providerKey: options.provider.providerKey,
      retryable: false,
      status: "healthy",
      statusCode: response.status,
    };
  } catch (error) {
    const latencyMs = Math.max(0, nowMs() - startedAt);
    const timedOut = error instanceof ProviderProbeTimeoutError;

    return {
      checkedAt,
      errorCode: timedOut ? "provider_probe_timeout" : "provider_request_failed",
      errorMessage: timedOut
        ? timeoutErrorMessage
        : error instanceof Error
          ? error.message
          : "Provider request failed.",
      latencyMs,
      ok: false,
      providerId: options.provider.id,
      providerKey: options.provider.providerKey,
      retryable: true,
      status: "failed",
      statusCode: null,
    };
  }
}

async function readProvider(
  databaseUrl: string,
  providerId: string,
): Promise<ConnectivityCheckProvider> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderRow>(
      `
        select id::text, provider_key, display_name, base_url
        from providers
        where id = $1
          and enabled = true
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

    return {
      baseUrl: row.base_url,
      displayName: row.display_name,
      id: row.id,
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
  const stored = await withClient(input.databaseUrl, async (client) => {
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
  await withClient(input.databaseUrl, async (client) => {
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

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderProbeTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/chat/completions`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function readProviderError(body: unknown): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : "provider_http_error";
    const message =
      typeof body.error.message === "string" ? body.error.message : "Provider request failed.";
    return { code, message };
  }

  return {
    code: "provider_http_error",
    message: "Provider request failed.",
  };
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return defaultTimeoutMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProviderProbeTimeoutError extends Error {
  constructor() {
    super(timeoutErrorMessage);
    this.name = "ProviderProbeTimeoutError";
  }
}

async function withClient<T>(
  databaseUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
