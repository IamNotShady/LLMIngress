import { withPostgresTransaction } from "@llmingress/db/client";
import { providerQuotaRefreshDelayMs, recordProviderQuota } from "@llmingress/db/provider-quota";
import type { ProviderQuotaErrorCode, QuotaEntry } from "@llmingress/domain/quota";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import { refreshProviderOAuthToken } from "@llmingress/provider/oauth";
import { type QuotaProbeResult, resolveQuotaProbe } from "@llmingress/provider/quota-probe";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { EncryptionKeySource } from "@llmingress/security/encryption-key";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { isRecord } from "@llmingress/util";
import {
  isProviderOAuthTokenExpired,
  readEncryptedSecret,
  readProviderOAuthTokenBlob,
  readWorkerEncryptionKeySource,
} from "./worker-credential-utils.ts";
import type { JobHandler } from "./worker-job-runner.ts";

type CreateProviderQuotaProbeJobHandlerOptions = {
  databaseUrl?: string;
  encryptionKeySource?: EncryptionKeySource;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

type ProviderQuotaProbePayload = {
  providerConnectionId: string;
  providerId: string;
};

type ProviderSnapshot = {
  baseUrl: string | null;
  id: string;
  providerKey: string;
  providerType: "api_key" | "local" | "subscription";
};

class QuotaProbeCanceledError extends Error {}

export function createProviderQuotaProbeJobHandler(
  options: CreateProviderQuotaProbeJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const payload = readProviderQuotaProbePayload(job.payload);
    let provider: ProviderSnapshot;
    try {
      provider = await readProviderSnapshot(options.databaseUrl, payload.providerId);
    } catch (error) {
      if (error instanceof QuotaProbeCanceledError) {
        return { canceled: true, reason: error.message };
      }
      throw error;
    }

    const persist = (result: { entries: QuotaEntry[]; errorCode: ProviderQuotaErrorCode | null }) =>
      persistQuota({
        databaseUrl: options.databaseUrl,
        entries: result.entries,
        errorCode: result.errorCode,
        providerConnectionId: payload.providerConnectionId,
        providerId: provider.id,
      });

    const unsupportedReason = readUnsupportedReason(provider);

    // A local Provider has no credential row; its provider-level state was
    // already validated by the snapshot read, and it never reports quota.
    if (provider.providerType === "local") {
      return persist({ entries: [], errorCode: unsupportedReason ?? "not_supported" });
    }

    // Connection state wins over the unsupported shortcut: a disabled or
    // probing-off connection cancels with no write, even on a Provider that
    // would otherwise persist a not_supported reason.
    let stored: StoredQuotaCredential;
    try {
      stored = await readStoredQuotaCredential({
        databaseUrl: options.databaseUrl,
        provider,
        providerConnectionId: payload.providerConnectionId,
      });
    } catch (error) {
      if (error instanceof QuotaProbeCanceledError) {
        return { canceled: true, reason: error.message };
      }
      return persist({ entries: [], errorCode: "probe_failed" });
    }

    if (unsupportedReason) {
      return persist({ entries: [], errorCode: unsupportedReason });
    }

    let credential: string;
    try {
      credential = await resolveQuotaCredentialSecret({
        databaseUrl: options.databaseUrl,
        encryptionKeySource: options.encryptionKeySource,
        fetch: options.fetch ?? globalThis.fetch,
        provider,
        providerConnectionId: payload.providerConnectionId,
        stored,
      });
    } catch (error) {
      if (error instanceof QuotaProbeCanceledError) {
        return { canceled: true, reason: error.message };
      }
      return persist({ entries: [], errorCode: "probe_failed" });
    }

    const probe = resolveQuotaProbe(provider.providerKey);
    if (!probe) {
      return persist({ entries: [], errorCode: "not_supported" });
    }
    if (!provider.baseUrl) {
      return persist({ entries: [], errorCode: "probe_failed" });
    }

    let result: QuotaProbeResult;
    try {
      result = await probe({
        baseUrl: provider.baseUrl,
        credential,
        fetch: options.fetch ?? globalThis.fetch,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      // A probe that throws — a malformed stored base URL is the known case —
      // must still leave a row behind, otherwise Console cannot tell an
      // unreadable connection from one that was never queried.
      result = {
        errorCode: "probe_failed",
        errorMessage: readErrorMessage(error),
        ok: false,
      };
    }

    return persist(
      result.ok
        ? { entries: result.entries, errorCode: null }
        : { entries: [], errorCode: result.errorCode },
    );
  };
}

/** Local Providers have no billing, and a Provider may declare it cannot report. */
function readUnsupportedReason(provider: ProviderSnapshot): ProviderQuotaErrorCode | null {
  if (provider.providerType === "local") {
    return "not_supported";
  }
  const quotaSource = resolveProviderDescriptor(provider.providerKey).quotaSource;
  if (!quotaSource) {
    return "not_supported";
  }
  return quotaSource.supported ? null : quotaSource.reason;
}

async function persistQuota(input: {
  databaseUrl?: string;
  entries: QuotaEntry[];
  errorCode: ProviderQuotaErrorCode | null;
  providerConnectionId: string;
  providerId: string;
}): Promise<Record<string, unknown>> {
  await recordProviderQuota({
    databaseUrl: input.databaseUrl,
    entries: input.entries,
    errorCode: input.errorCode,
    nextRefreshAt: new Date(Date.now() + providerQuotaRefreshDelayMs(input.errorCode)),
    providerConnectionId: input.providerConnectionId,
    providerId: input.providerId,
  });
  return {
    entryCount: input.entries.length,
    errorCode: input.errorCode,
    providerConnectionId: input.providerConnectionId,
    providerId: input.providerId,
  };
}

async function readProviderSnapshot(
  databaseUrl: string | undefined,
  providerId: string,
): Promise<ProviderSnapshot> {
  return withPostgresTransaction(databaseUrl, async (client) => {
    const result = await client.query<{
      base_url: string | null;
      enabled: boolean;
      id: string;
      provider_key: string;
      provider_type: ProviderSnapshot["providerType"];
    }>(
      `
        select id::text,
               provider_type,
               provider_key,
               base_url,
               enabled
        from providers
        where id = $1
          and deleted_at is null
      `,
      [providerId],
    );
    const row = result.rows[0];
    if (!row?.enabled) {
      throw new QuotaProbeCanceledError("provider_disabled_or_missing");
    }
    return {
      baseUrl: row.base_url,
      id: row.id,
      providerKey: row.provider_key,
      providerType: row.provider_type,
    };
  });
}

type StoredQuotaCredential = { encryptedSecret: unknown; kind: "api_key" | "oauth" };

/**
 * Reads and validates the credential row without decrypting it, so the
 * handler can honor disabled / probing-off state before deciding anything
 * else — including the unsupported shortcut.
 */
async function readStoredQuotaCredential(input: {
  databaseUrl?: string;
  provider: ProviderSnapshot;
  providerConnectionId: string;
}): Promise<StoredQuotaCredential> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    if (input.provider.providerType === "api_key") {
      const result = await client.query<{
        enabled: boolean;
        encrypted_key: unknown;
        quota_probe_enabled: boolean;
      }>(
        `
          select encrypted_key, enabled, quota_probe_enabled
          from provider_api_keys
          where id = $1
            and provider_id = $2
            and deleted_at is null
        `,
        [input.providerConnectionId, input.provider.id],
      );
      const row = result.rows[0];
      if (!row?.enabled) {
        throw new QuotaProbeCanceledError("provider_connection_disabled_or_missing");
      }
      if (!row.quota_probe_enabled) {
        throw new QuotaProbeCanceledError("quota_probe_disabled");
      }
      return { encryptedSecret: row.encrypted_key, kind: "api_key" as const };
    }

    const result = await client.query<{
      completed_at: Date | null;
      enabled: boolean;
      encrypted_token: unknown;
      quota_probe_enabled: boolean;
    }>(
      `
        select encrypted_token, enabled, completed_at, quota_probe_enabled
        from provider_oauth
        where id = $1
          and provider_id = $2
          and deleted_at is null
      `,
      [input.providerConnectionId, input.provider.id],
    );
    const row = result.rows[0];
    if (!row?.enabled || !row.completed_at || !row.encrypted_token) {
      throw new QuotaProbeCanceledError("provider_connection_disabled_or_missing");
    }
    if (!row.quota_probe_enabled) {
      throw new QuotaProbeCanceledError("quota_probe_disabled");
    }
    return { encryptedSecret: row.encrypted_token, kind: "oauth" as const };
  });
}

async function resolveQuotaCredentialSecret(input: {
  databaseUrl?: string;
  encryptionKeySource?: EncryptionKeySource;
  fetch: typeof globalThis.fetch;
  provider: ProviderSnapshot;
  providerConnectionId: string;
  stored: StoredQuotaCredential;
}): Promise<string> {
  const encryptionKeySource =
    input.encryptionKeySource ??
    readWorkerEncryptionKeySource(process.env, "provider quota probes");
  const stored = input.stored;

  const encryption = createSecretEncryption(encryptionKeySource);
  if (stored.kind === "api_key") {
    return encryption.decrypt(readEncryptedSecret(stored.encryptedSecret));
  }

  let token = readProviderOAuthTokenBlob(
    encryption.decrypt(readEncryptedSecret(stored.encryptedSecret)),
  );
  if (!isProviderOAuthTokenExpired(token)) {
    return token.accessToken;
  }
  if (!token.refreshToken || !isSubscriptionProviderKey(input.provider.providerKey)) {
    throw new Error("Provider OAuth token expired and cannot be refreshed.");
  }
  token = await refreshProviderOAuthToken({
    fetch: input.fetch,
    providerKey: input.provider.providerKey,
    refreshToken: token.refreshToken,
  });
  const encryptedSecret = encryption.encrypt(JSON.stringify(token));
  await withPostgresTransaction(input.databaseUrl, async (client) => {
    const updated = await client.query(
      `
        update provider_oauth
        set encrypted_token = $3::jsonb,
            token_expires_at = $4,
            updated_at = now()
        where id = $1
          and provider_id = $2
          and enabled = true
          and deleted_at is null
          and encrypted_token = $5::jsonb
      `,
      [
        input.providerConnectionId,
        input.provider.id,
        JSON.stringify(encryptedSecret),
        token.expiresAt === null ? null : new Date(token.expiresAt),
        JSON.stringify(stored.encryptedSecret),
      ],
    );
    if (updated.rowCount !== 1) {
      throw new QuotaProbeCanceledError("provider_connection_changed_during_oauth_refresh");
    }
  });
  return token.accessToken;
}

function readProviderQuotaProbePayload(payload: unknown): ProviderQuotaProbePayload {
  if (
    !isRecord(payload) ||
    typeof payload.providerId !== "string" ||
    !payload.providerId.trim() ||
    typeof payload.providerConnectionId !== "string" ||
    !payload.providerConnectionId.trim()
  ) {
    throw new Error(
      "provider_quota_probe job payload requires providerId and providerConnectionId.",
    );
  }
  return {
    providerConnectionId: payload.providerConnectionId.trim(),
    providerId: payload.providerId.trim(),
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Provider quota probe failed.";
}
