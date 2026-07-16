import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import {
  providerConnectionProbeRetryDelayMs as readProviderConnectionProbeRetryDelayMs,
  recordProviderConnectionProbeResultWithClient,
} from "@llmingress/db/provider-health";
import {
  checkProviderConnectivity,
  type ProviderConnectivityCheckResult,
  selectProviderProbeModels,
} from "@llmingress/provider/connectivity";
import { fetchListedProviderModels } from "@llmingress/provider/model-list";
import { refreshProviderOAuthToken } from "@llmingress/provider/oauth";
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

type CreateProviderConnectionProbeJobHandlerOptions = {
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  encryptionKeySource?: EncryptionKeySource;
  timeoutMs?: number;
};

type ProviderConnectionProbePayload = {
  providerConnectionId: string;
  providerId: string;
};

type ProviderSnapshot = {
  baseUrl: string | null;
  displayName: string;
  id: string;
  providerKey: string;
  providerType: "api_key" | "local" | "subscription";
  updatedAt: string;
};

type CredentialSnapshot = {
  encryptedSecret: unknown;
  id: string;
  kind: "api_key" | "oauth";
};

type ProbeCredential = {
  plaintext: string | null;
  snapshot: CredentialSnapshot | null;
};

type ProbeModelCandidate = {
  contextWindow: number | null;
  inputUsdPerMillionTokens: string | null;
  modelId: string;
  outputUsdPerMillionTokens: string | null;
};

type ProbeAttempt = Pick<
  ProviderConnectivityCheckResult,
  | "errorCode"
  | "errorMessage"
  | "latencyMs"
  | "ok"
  | "probeModelId"
  | "retryable"
  | "status"
  | "statusCode"
>;

class ProbeCanceledError extends Error {}
class ProbeCredentialFailure extends Error {
  constructor(
    message: string,
    readonly snapshot: CredentialSnapshot,
  ) {
    super(message);
  }
}

export { readProviderConnectionProbeRetryDelayMs as providerConnectionProbeRetryDelayMs };

export function createProviderConnectionProbeJobHandler(
  options: CreateProviderConnectionProbeJobHandlerOptions,
): JobHandler {
  return async (job) => {
    const payload = readProviderConnectionProbePayload(job.payload);
    let provider: ProviderSnapshot;
    try {
      provider = await readProviderSnapshot(options.databaseUrl, payload.providerId);
    } catch (error) {
      if (error instanceof ProbeCanceledError) {
        return { canceled: true, reason: error.message };
      }
      throw error;
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    let credential: ProbeCredential;
    try {
      credential = await readProbeCredential({
        databaseUrl: options.databaseUrl,
        fetch: fetchImpl,
        encryptionKeySource: options.encryptionKeySource,
        provider,
        providerConnectionId: payload.providerConnectionId,
      });
    } catch (error) {
      if (error instanceof ProbeCanceledError) {
        return { canceled: true, reason: error.message };
      }
      return persistProbeResult({
        attempts: [],
        databaseUrl: options.databaseUrl,
        errorCode: "provider_connection_credential_unavailable",
        errorMessage: readErrorMessage(error),
        jobId: job.id,
        provider,
        providerConnectionId: payload.providerConnectionId,
        snapshot: error instanceof ProbeCredentialFailure ? error.snapshot : null,
        trigger: job.trigger,
      });
    }

    if (!provider.baseUrl) {
      return persistProbeResult({
        attempts: [],
        databaseUrl: options.databaseUrl,
        errorCode: "provider_base_url_missing",
        errorMessage: "Provider has no base URL for connection probe.",
        jobId: job.id,
        provider,
        providerConnectionId: payload.providerConnectionId,
        snapshot: credential.snapshot,
        trigger: job.trigger,
      });
    }

    let models = await readProbeModels(options.databaseUrl, provider.id);
    if (models.length === 0) {
      try {
        const listedModels = await fetchListedProviderModels({
          apiKey: credential.plaintext,
          baseUrl: provider.baseUrl,
          fetch: fetchImpl,
          providerKey: provider.providerKey,
        });
        models = listedModels.map((model) => ({
          contextWindow: model.contextWindow ?? null,
          inputUsdPerMillionTokens: null,
          modelId: model.modelId,
          outputUsdPerMillionTokens: null,
        }));
      } catch (error) {
        return persistProbeResult({
          attempts: [],
          databaseUrl: options.databaseUrl,
          errorCode: "provider_model_discovery_failed",
          errorMessage: readErrorMessage(error),
          jobId: job.id,
          provider,
          providerConnectionId: payload.providerConnectionId,
          snapshot: credential.snapshot,
          trigger: job.trigger,
        });
      }
    }

    const probeModelIds = selectProviderProbeModels(models, 3);
    if (probeModelIds.length === 0) {
      return {
        inconclusive: true,
        providerConnectionId: payload.providerConnectionId,
        providerId: provider.id,
        reason: "provider_probe_model_unavailable",
      };
    }

    const attempts: ProbeAttempt[] = [];
    for (const modelId of probeModelIds) {
      const result = await checkProviderConnectivity({
        apiKey: credential.plaintext,
        fetch: fetchImpl,
        provider: {
          baseUrl: provider.baseUrl,
          displayName: provider.displayName,
          id: provider.id,
          modelId,
          providerKey: provider.providerKey,
        },
        timeoutMs: options.timeoutMs,
      });
      attempts.push(result);
      if (result.ok) {
        break;
      }
    }

    const success = attempts.find((attempt) => attempt.ok);
    const representative = success ?? attempts.at(-1);
    return persistProbeResult({
      attempts,
      databaseUrl: options.databaseUrl,
      errorCode: success ? null : (representative?.errorCode ?? "provider_connection_probe_failed"),
      errorMessage: success
        ? null
        : (representative?.errorMessage ?? "Provider connection probe failed."),
      jobId: job.id,
      provider,
      providerConnectionId: payload.providerConnectionId,
      snapshot: credential.snapshot,
      status: success ? "healthy" : "unhealthy",
      trigger: job.trigger,
    });
  };
}

async function readProviderSnapshot(
  databaseUrl: string | undefined,
  providerId: string,
): Promise<ProviderSnapshot> {
  return withPostgresTransaction(databaseUrl, async (client) => {
    const result = await client.query<{
      base_url: string | null;
      display_name: string;
      enabled: boolean;
      id: string;
      provider_key: string;
      provider_type: ProviderSnapshot["providerType"];
      updated_at: string;
    }>(
      `
        select id::text,
               provider_type,
               provider_key,
               display_name,
               base_url,
               enabled,
               updated_at::text
        from providers
        where id = $1
          and deleted_at is null
      `,
      [providerId],
    );
    const row = result.rows[0];
    if (!row?.enabled) {
      throw new ProbeCanceledError("provider_disabled_or_missing");
    }
    return {
      baseUrl: row.base_url,
      displayName: row.display_name,
      id: row.id,
      providerKey: row.provider_key,
      providerType: row.provider_type,
      updatedAt: row.updated_at,
    };
  });
}

async function readProbeCredential(input: {
  databaseUrl?: string;
  fetch: typeof globalThis.fetch;
  encryptionKeySource?: EncryptionKeySource;
  provider: ProviderSnapshot;
  providerConnectionId: string;
}): Promise<ProbeCredential> {
  if (input.provider.providerType === "local") {
    if (input.providerConnectionId !== input.provider.id) {
      throw new ProbeCanceledError("local_provider_connection_missing");
    }
    return { plaintext: null, snapshot: null };
  }

  const encryptionKeySource =
    input.encryptionKeySource ??
    readWorkerEncryptionKeySource(process.env, "provider connection probes");

  const stored = await withPostgresTransaction(input.databaseUrl, async (client) => {
    if (input.provider.providerType === "api_key") {
      const result = await client.query<{
        encrypted_key: unknown;
        enabled: boolean;
      }>(
        `
          select encrypted_key, enabled
          from provider_api_keys
          where id = $1
            and provider_id = $2
            and deleted_at is null
        `,
        [input.providerConnectionId, input.provider.id],
      );
      const row = result.rows[0];
      if (!row?.enabled) {
        throw new ProbeCanceledError("provider_connection_disabled_or_missing");
      }
      return { encryptedSecret: row.encrypted_key, kind: "api_key" as const };
    }

    const result = await client.query<{
      completed_at: Date | null;
      encrypted_token: unknown;
      enabled: boolean;
    }>(
      `
        select encrypted_token, enabled, completed_at
        from provider_oauth
        where id = $1
          and provider_id = $2
          and deleted_at is null
      `,
      [input.providerConnectionId, input.provider.id],
    );
    const row = result.rows[0];
    if (!row?.enabled || !row.completed_at || !row.encrypted_token) {
      throw new ProbeCanceledError("provider_connection_disabled_or_missing");
    }
    return { encryptedSecret: row.encrypted_token, kind: "oauth" as const };
  });

  const encryption = createSecretEncryption(encryptionKeySource);
  const snapshot: CredentialSnapshot = {
    encryptedSecret: stored.encryptedSecret,
    id: input.providerConnectionId,
    kind: stored.kind,
  };
  if (stored.kind === "api_key") {
    try {
      return {
        plaintext: encryption.decrypt(readEncryptedSecret(stored.encryptedSecret)),
        snapshot,
      };
    } catch (error) {
      throw new ProbeCredentialFailure(readErrorMessage(error), snapshot);
    }
  }

  try {
    let token = readProviderOAuthTokenBlob(
      encryption.decrypt(readEncryptedSecret(stored.encryptedSecret)),
    );
    let encryptedSecret = stored.encryptedSecret;
    if (isProviderOAuthTokenExpired(token)) {
      if (!token.refreshToken || !isSubscriptionProviderKey(input.provider.providerKey)) {
        throw new Error("Provider OAuth token expired and cannot be refreshed.");
      }
      token = await refreshProviderOAuthToken({
        fetch: input.fetch,
        providerKey: input.provider.providerKey,
        refreshToken: token.refreshToken,
      });
      encryptedSecret = encryption.encrypt(JSON.stringify(token));
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
          throw new ProbeCanceledError("provider_connection_changed_during_oauth_refresh");
        }
      });
    }

    return {
      plaintext: token.accessToken,
      snapshot: {
        encryptedSecret,
        id: input.providerConnectionId,
        kind: "oauth",
      },
    };
  } catch (error) {
    if (error instanceof ProbeCanceledError) {
      throw error;
    }
    throw new ProbeCredentialFailure(readErrorMessage(error), snapshot);
  }
}

async function readProbeModels(
  databaseUrl: string | undefined,
  providerId: string,
): Promise<ProbeModelCandidate[]> {
  return withPostgresTransaction(databaseUrl, async (client) => {
    const result = await client.query<{
      context_window: number | null;
      input_price: string | null;
      model_id: string;
      output_price: string | null;
    }>(
      `
        select model_id,
               context_window,
               coalesce(
                 manual_input_usd_per_million_tokens,
                 synced_input_usd_per_million_tokens
               )::text as input_price,
               coalesce(
                 manual_output_usd_per_million_tokens,
                 synced_output_usd_per_million_tokens
               )::text as output_price
        from provider_models
        where provider_id = $1
          and availability = 'available'
          and deleted_at is null
      `,
      [providerId],
    );
    return result.rows.map((row) => ({
      contextWindow: row.context_window,
      inputUsdPerMillionTokens: row.input_price,
      modelId: row.model_id,
      outputUsdPerMillionTokens: row.output_price,
    }));
  });
}

async function persistProbeResult(input: {
  attempts: ProbeAttempt[];
  databaseUrl?: string;
  errorCode: string | null;
  errorMessage: string | null;
  jobId: string;
  provider: ProviderSnapshot;
  providerConnectionId: string;
  snapshot: CredentialSnapshot | null;
  status?: "healthy" | "unhealthy";
  trigger: string;
}): Promise<Record<string, unknown>> {
  const status = input.status ?? "unhealthy";
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const current = await providerSnapshotIsCurrent(client, input.provider, input.snapshot);
    if (!current) {
      return { canceled: true, reason: "provider_connection_probe_snapshot_stale" };
    }
    const persistence = await recordProviderConnectionProbeResultWithClient(client, {
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      jobId: input.jobId,
      latencyMs: input.attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
      metadata: {
        modelAttempts: input.attempts.map((attempt) => ({
          errorCode: attempt.errorCode,
          errorMessage: attempt.errorMessage,
          latencyMs: attempt.latencyMs,
          modelId: attempt.probeModelId,
          ok: attempt.ok,
          retryable: attempt.retryable,
          status: attempt.status,
          statusCode: attempt.statusCode,
        })),
        providerKey: input.provider.providerKey,
      },
      observedAt: new Date(),
      providerConnectionId: input.providerConnectionId,
      providerId: input.provider.id,
      status,
      trigger: input.trigger === "manual" ? "manual" : "worker_probe",
    });
    return {
      ...persistence,
      providerConnectionId: input.providerConnectionId,
      providerId: input.provider.id,
      status,
    };
  });
}

async function providerSnapshotIsCurrent(
  client: PostgresQueryClient,
  provider: ProviderSnapshot,
  credential: CredentialSnapshot | null,
): Promise<boolean> {
  const providerResult = await client.query<{ current: boolean }>(
    `
      select enabled
             and deleted_at is null
             and updated_at::text = $2
             and base_url is not distinct from $3
             and provider_type = $4
             as current
      from providers
      where id = $1
      for update
    `,
    [provider.id, provider.updatedAt, provider.baseUrl, provider.providerType],
  );
  if (providerResult.rows[0]?.current !== true) {
    return false;
  }
  if (!credential) {
    return true;
  }

  const table = credential.kind === "api_key" ? "provider_api_keys" : "provider_oauth";
  const secretColumn = credential.kind === "api_key" ? "encrypted_key" : "encrypted_token";
  const completedCheck = credential.kind === "oauth" ? "and completed_at is not null" : "";
  const result = await client.query<{ current: boolean }>(
    `
      select enabled
             and deleted_at is null
             and ${secretColumn} = $3::jsonb
             ${completedCheck}
             as current
      from ${table}
      where id = $1
        and provider_id = $2
      for update
    `,
    [credential.id, provider.id, JSON.stringify(credential.encryptedSecret)],
  );
  return result.rows[0]?.current === true;
}

function readProviderConnectionProbePayload(payload: unknown): ProviderConnectionProbePayload {
  if (
    !isRecord(payload) ||
    typeof payload.providerId !== "string" ||
    !payload.providerId.trim() ||
    typeof payload.providerConnectionId !== "string" ||
    !payload.providerConnectionId.trim()
  ) {
    throw new Error(
      "provider_connection_probe job payload requires providerId and providerConnectionId.",
    );
  }
  return {
    providerConnectionId: payload.providerConnectionId.trim(),
    providerId: payload.providerId.trim(),
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Provider connection probe failed.";
}
