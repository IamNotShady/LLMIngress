import { randomUUID } from "node:crypto";
import { type PostgresQueryResultRow, withPostgresClient } from "@llmingress/db/client";

export type {
  PostgresQueryClient,
  PostgresQueryResult,
  PostgresQueryResultRow,
} from "@llmingress/db/client";
export { PostgresClient, withPostgresClient } from "@llmingress/db/client";

export const removedProviderKeys = ["fireworks", "groq", "mistral"] as const;

const removedProviderKeySet = new Set<string>(removedProviderKeys);

export function isRemovedProviderKey(providerKey: string | null | undefined): boolean {
  const normalized = providerKey?.trim().toLowerCase();
  return normalized ? removedProviderKeySet.has(normalized) : false;
}

export type ProviderOAuthTestStatus =
  | "auth_failed"
  | "healthy"
  | "network_error"
  | "quota_limited"
  | "unknown"
  | "unhealthy";

export type ProviderOAuthMetadata = {
  completedAt: Date | null;
  createdAt: Date;
  enabled: boolean;
  id: string;
  label: string | null;
  lastTestErrorCode: string | null;
  lastTestErrorMessage: string | null;
  lastTestStatus: ProviderOAuthTestStatus;
  lastTestedAt: Date | null;
  priority: number;
  providerId: string;
  tokenExpiresAt: Date | null;
  updatedAt: Date;
};

export type ProviderOAuthPendingConnection = ProviderOAuthMetadata & {
  pendingCodeChallenge: string | null;
  pendingCodeVerifier: string | null;
  pendingExpiresAt: Date | null;
  pendingState: string | null;
  providerKey: string;
};

export type ProviderOAuthRuntimeConnection = ProviderOAuthMetadata & {
  encryptedToken: Record<string, unknown>;
  providerKey: string;
};

type ProviderOAuthRow = PostgresQueryResultRow & {
  completed_at: Date | null;
  created_at: Date;
  enabled: boolean;
  id: string;
  label: string | null;
  last_test_error_code: string | null;
  last_test_error_message: string | null;
  last_test_status: ProviderOAuthTestStatus;
  last_tested_at: Date | null;
  priority: number;
  provider_id: string;
  token_expires_at: Date | null;
  updated_at: Date;
};

type ProviderOAuthPendingRow = ProviderOAuthRow & {
  pending_code_challenge: string | null;
  pending_code_verifier: string | null;
  pending_expires_at: Date | null;
  pending_state: string | null;
  provider_key: string;
};

type ProviderOAuthRuntimeRow = ProviderOAuthRow & {
  encrypted_token: unknown;
  provider_key: string;
};

export async function listProviderOAuthMetadata(
  databaseUrl: string,
): Promise<ProviderOAuthMetadata[]> {
  return withPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        select id::text,
               provider_id::text,
               label,
               priority,
               enabled,
               token_expires_at,
               last_test_status,
               last_tested_at,
               last_test_error_code,
               last_test_error_message,
               created_at,
               updated_at,
               completed_at
        from provider_oauth
        order by provider_id,
                 priority asc,
                 created_at asc,
                 id asc
      `,
    );
    return result.rows.map(toProviderOAuthMetadata);
  });
}

export async function createProviderOAuthPendingConnection(input: {
  databaseUrl: string;
  label?: string | null;
  pendingCodeChallenge: string;
  pendingCodeVerifier: string;
  pendingExpiresAt: Date;
  pendingState: string;
  priority?: number;
  providerId: string;
}): Promise<ProviderOAuthMetadata> {
  const rowId = cryptoRandomUUID();
  return withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        insert into provider_oauth (
          id,
          provider_id,
          label,
          priority,
          pending_state,
          pending_code_verifier,
          pending_code_challenge,
          pending_expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id::text,
                  provider_id::text,
                  label,
                  priority,
                  enabled,
                  token_expires_at,
                  last_test_status,
                  last_tested_at,
                  last_test_error_code,
                  last_test_error_message,
                  created_at,
                  updated_at,
                  completed_at
      `,
      [
        rowId,
        input.providerId,
        normalizeProviderOAuthLabel(input.label),
        normalizeProviderOAuthPriority(input.priority),
        input.pendingState,
        input.pendingCodeVerifier,
        input.pendingCodeChallenge,
        input.pendingExpiresAt,
      ],
    );
    return toProviderOAuthMetadata(requireProviderOAuthRow(result.rows[0]));
  });
}

export async function readProviderOAuthPendingConnection(input: {
  databaseUrl: string;
  providerOAuthId: string;
}): Promise<ProviderOAuthPendingConnection> {
  return withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthPendingRow>(
      `
        select provider_oauth.id::text,
               provider_oauth.provider_id::text,
               provider_oauth.label,
               provider_oauth.priority,
               provider_oauth.enabled,
               provider_oauth.pending_state,
               provider_oauth.pending_code_verifier,
               provider_oauth.pending_code_challenge,
               provider_oauth.pending_expires_at,
               provider_oauth.token_expires_at,
               provider_oauth.last_test_status,
               provider_oauth.last_tested_at,
               provider_oauth.last_test_error_code,
               provider_oauth.last_test_error_message,
               provider_oauth.created_at,
               provider_oauth.updated_at,
               provider_oauth.completed_at,
               providers.provider_key
        from provider_oauth
        join providers on providers.id = provider_oauth.provider_id
        where provider_oauth.id = $1
          and providers.deleted_at is null
      `,
      [input.providerOAuthId],
    );
    return toProviderOAuthPendingConnection(requireProviderOAuthRow(result.rows[0]));
  });
}

export async function completeProviderOAuthConnection(input: {
  databaseUrl: string;
  encryptedToken: Record<string, unknown>;
  providerOAuthId: string;
  tokenExpiresAt?: Date | null;
}): Promise<ProviderOAuthMetadata> {
  return withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        update provider_oauth
        set encrypted_token = $2,
            token_expires_at = $3,
            pending_state = null,
            pending_code_verifier = null,
            pending_code_challenge = null,
            pending_expires_at = null,
            completed_at = coalesce(completed_at, now()),
            updated_at = now()
        where id = $1
        returning id::text,
                  provider_id::text,
                  label,
                  priority,
                  enabled,
                  token_expires_at,
                  last_test_status,
                  last_tested_at,
                  last_test_error_code,
                  last_test_error_message,
                  created_at,
                  updated_at,
                  completed_at
      `,
      [input.providerOAuthId, JSON.stringify(input.encryptedToken), input.tokenExpiresAt ?? null],
    );
    return toProviderOAuthMetadata(requireProviderOAuthRow(result.rows[0]));
  });
}

export async function setProviderOAuthConnectionEnabled(input: {
  databaseUrl: string;
  enabled: boolean;
  providerOAuthId: string;
}): Promise<ProviderOAuthMetadata> {
  return withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        update provider_oauth
        set enabled = $2,
            updated_at = now()
        where id = $1
        returning id::text,
                  provider_id::text,
                  label,
                  priority,
                  enabled,
                  token_expires_at,
                  last_test_status,
                  last_tested_at,
                  last_test_error_code,
                  last_test_error_message,
                  created_at,
                  updated_at,
                  completed_at
      `,
      [input.providerOAuthId, input.enabled],
    );
    return toProviderOAuthMetadata(requireProviderOAuthRow(result.rows[0]));
  });
}

export async function deleteProviderOAuthConnection(input: {
  databaseUrl: string;
  providerOAuthId: string;
}): Promise<{ providerId: string }> {
  return withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<{ provider_id: string }>(
      `
        delete from provider_oauth
        where id = $1
        returning provider_id::text
      `,
      [input.providerOAuthId],
    );
    const providerId = result.rows[0]?.provider_id;
    if (!providerId) {
      throw new Error("Provider OAuth connection was not found.");
    }
    return { providerId };
  });
}

export async function readEnabledCompletedProviderOAuthConnections(input: {
  databaseUrl: string;
  providerId: string;
}): Promise<ProviderOAuthRuntimeConnection[]> {
  return withPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRuntimeRow>(
      `
        select provider_oauth.id::text,
               provider_oauth.provider_id::text,
               provider_oauth.label,
               provider_oauth.priority,
               provider_oauth.enabled,
               provider_oauth.encrypted_token,
               provider_oauth.token_expires_at,
               provider_oauth.last_test_status,
               provider_oauth.last_tested_at,
               provider_oauth.last_test_error_code,
               provider_oauth.last_test_error_message,
               provider_oauth.created_at,
               provider_oauth.updated_at,
               provider_oauth.completed_at,
               providers.provider_key
        from provider_oauth
        join providers on providers.id = provider_oauth.provider_id
        where provider_oauth.provider_id = $1
          and provider_oauth.enabled = true
          and provider_oauth.completed_at is not null
          and provider_oauth.encrypted_token is not null
        order by provider_oauth.priority asc,
                 provider_oauth.created_at asc,
                 provider_oauth.id asc
      `,
      [input.providerId],
    );
    return result.rows.map(toProviderOAuthRuntimeConnection);
  });
}

export async function updateProviderOAuthTestResult(input: {
  databaseUrl: string;
  errorCode: string | null;
  errorMessage: string | null;
  providerOAuthId: string;
  status: ProviderOAuthTestStatus;
  testedAt: string | Date;
}): Promise<void> {
  await withPostgresClient(input.databaseUrl, async (client) => {
    await client.query(
      `
        update provider_oauth
        set last_tested_at = $2::timestamptz,
            last_test_status = $3,
            last_test_error_code = $4,
            last_test_error_message = $5,
            updated_at = now()
        where id = $1
      `,
      [input.providerOAuthId, input.testedAt, input.status, input.errorCode, input.errorMessage],
    );
  });
}

function toProviderOAuthMetadata(row: ProviderOAuthRow): ProviderOAuthMetadata {
  return {
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    id: row.id,
    label: row.label,
    lastTestErrorCode: row.last_test_error_code,
    lastTestErrorMessage: row.last_test_error_message,
    lastTestStatus: row.last_test_status,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at) : null,
    priority: row.priority,
    providerId: row.provider_id,
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
    updatedAt: new Date(row.updated_at),
  };
}

function toProviderOAuthPendingConnection(
  row: ProviderOAuthPendingRow,
): ProviderOAuthPendingConnection {
  return {
    ...toProviderOAuthMetadata(row),
    pendingCodeChallenge: row.pending_code_challenge,
    pendingCodeVerifier: row.pending_code_verifier,
    pendingExpiresAt: row.pending_expires_at ? new Date(row.pending_expires_at) : null,
    pendingState: row.pending_state,
    providerKey: row.provider_key,
  };
}

function toProviderOAuthRuntimeConnection(
  row: ProviderOAuthRuntimeRow,
): ProviderOAuthRuntimeConnection {
  return {
    ...toProviderOAuthMetadata(row),
    encryptedToken: readJsonObject(row.encrypted_token, "Provider OAuth token"),
    providerKey: row.provider_key,
  };
}

function normalizeProviderOAuthLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (label && label.length > 100) {
    throw new Error("Provider OAuth connection label must be at most 100 characters.");
  }
  return label || null;
}

function normalizeProviderOAuthPriority(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Provider OAuth connection priority must be between 0 and 100.");
  }
  return value;
}

function readJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // handled by final throw
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} payload was not recognized.`);
}

function requireProviderOAuthRow<T extends ProviderOAuthRow>(row: T | undefined): T {
  if (!row) {
    throw new Error("Provider OAuth connection was not found.");
  }
  return row;
}

function cryptoRandomUUID(): string {
  return randomUUID();
}

export type {
  NormalizedProviderModelRefreshInput,
  ProviderModelRefreshInput,
  QueuedProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
export {
  buildJobCreatedNotificationPayload,
  buildModelRefreshJobPayload,
  enqueueProviderConnectivityCheckJob,
  enqueueProviderModelRefreshJob,
  normalizeProviderModelRefreshInput,
} from "@llmingress/db/provider-jobs";
