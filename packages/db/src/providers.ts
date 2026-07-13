import { randomUUID } from "node:crypto";
import { withPooledPostgresClient, withPostgresTransaction } from "@llmingress/db/client";
import { clearProviderConnectionHealthWithClient } from "@llmingress/db/provider-health";

export type {
  PostgresQueryClient,
  PostgresQueryResult,
  PostgresQueryResultRow,
} from "@llmingress/db/client";
export { PostgresClient, withPooledPostgresClient } from "@llmingress/db/client";

export type ProviderOAuthMetadata = {
  completedAt: Date | null;
  createdAt: Date;
  enabled: boolean;
  id: string;
  label: string | null;
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

type ProviderOAuthRow = {
  completed_at: Date | null;
  created_at: Date;
  enabled: boolean;
  id: string;
  label: string | null;
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
  databaseUrl: string | undefined,
): Promise<ProviderOAuthMetadata[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        select id::text,
               provider_id::text,
               label,
               priority,
               enabled,
               token_expires_at,
               created_at,
               updated_at,
               completed_at
        from provider_oauth
        where completed_at is not null
          and encrypted_token is not null
          and deleted_at is null
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
  databaseUrl?: string;
  label?: string | null;
  pendingCodeChallenge: string;
  pendingCodeVerifier: string;
  pendingExpiresAt: Date;
  pendingState: string;
  priority?: number;
  providerId: string;
}): Promise<ProviderOAuthMetadata> {
  const rowId = cryptoRandomUUID();
  return withPostgresTransaction(input.databaseUrl, async (client) => {
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
  databaseUrl?: string;
  providerOAuthId: string;
}): Promise<ProviderOAuthPendingConnection> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
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
               provider_oauth.created_at,
               provider_oauth.updated_at,
               provider_oauth.completed_at,
               providers.provider_key
        from provider_oauth
        join providers on providers.id = provider_oauth.provider_id
        where provider_oauth.id = $1
          and provider_oauth.deleted_at is null
          and providers.deleted_at is null
      `,
      [input.providerOAuthId],
    );
    return toProviderOAuthPendingConnection(requireProviderOAuthRow(result.rows[0]));
  });
}

export async function completeProviderOAuthConnection(input: {
  databaseUrl?: string;
  encryptedToken: Record<string, unknown>;
  label?: string | null;
  priority?: number;
  providerOAuthId: string;
  tokenExpiresAt?: Date | null;
}): Promise<ProviderOAuthMetadata> {
  const shouldUpdateLabel = Object.hasOwn(input, "label");
  const shouldUpdatePriority = input.priority !== undefined;

  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        update provider_oauth
        set encrypted_token = $2,
            token_expires_at = $3,
            label = case when $4::boolean then $5::text else label end,
            priority = case when $6::boolean then $7::integer else priority end,
            pending_state = null,
            pending_code_verifier = null,
            pending_code_challenge = null,
            pending_expires_at = null,
            completed_at = coalesce(completed_at, now()),
            updated_at = now()
        where id = $1
          and deleted_at is null
        returning id::text,
                  provider_id::text,
                  label,
                  priority,
                  enabled,
                  token_expires_at,
                  created_at,
                  updated_at,
                  completed_at
      `,
      [
        input.providerOAuthId,
        JSON.stringify(input.encryptedToken),
        input.tokenExpiresAt ?? null,
        shouldUpdateLabel,
        shouldUpdateLabel ? normalizeProviderOAuthLabel(input.label) : null,
        shouldUpdatePriority,
        shouldUpdatePriority ? normalizeProviderOAuthPriority(input.priority) : null,
      ],
    );
    const row = requireProviderOAuthRow(result.rows[0]);
    await clearProviderConnectionHealthWithClient(client, {
      providerConnectionId: row.id,
      providerId: row.provider_id,
    });
    return toProviderOAuthMetadata(row);
  });
}

export async function setProviderOAuthConnectionEnabled(input: {
  databaseUrl?: string;
  enabled: boolean;
  providerOAuthId: string;
}): Promise<ProviderOAuthMetadata> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRow>(
      `
        update provider_oauth
        set enabled = $2,
            updated_at = now()
        where id = $1
          and deleted_at is null
        returning id::text,
                  provider_id::text,
                  label,
                  priority,
                  enabled,
                  token_expires_at,
                  created_at,
                  updated_at,
                  completed_at
      `,
      [input.providerOAuthId, input.enabled],
    );
    const row = requireProviderOAuthRow(result.rows[0]);
    await clearProviderConnectionHealthWithClient(client, {
      providerConnectionId: row.id,
      providerId: row.provider_id,
    });
    return toProviderOAuthMetadata(row);
  });
}

export async function deleteProviderOAuthConnection(input: {
  databaseUrl?: string;
  providerOAuthId: string;
}): Promise<{ providerId: string }> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const result = await client.query<{ provider_id: string }>(
      `
        update provider_oauth
        set deleted_at = now(),
            enabled = false,
            updated_at = now()
        where id = $1
          and deleted_at is null
        returning provider_id::text
      `,
      [input.providerOAuthId],
    );
    const providerId = result.rows[0]?.provider_id;
    if (!providerId) {
      throw new Error("Provider OAuth connection was not found.");
    }
    await clearProviderConnectionHealthWithClient(client, {
      providerConnectionId: input.providerOAuthId,
      providerId,
    });
    return { providerId };
  });
}

export async function readProviderOAuthRuntimeConnection(input: {
  databaseUrl?: string;
  providerOAuthId: string;
}): Promise<ProviderOAuthRuntimeConnection> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRuntimeRow>(
      `
        select provider_oauth.id::text,
               provider_oauth.provider_id::text,
               provider_oauth.label,
               provider_oauth.priority,
               provider_oauth.enabled,
               provider_oauth.encrypted_token,
               provider_oauth.token_expires_at,
               provider_oauth.created_at,
               provider_oauth.updated_at,
               provider_oauth.completed_at,
               providers.provider_key
        from provider_oauth
        join providers on providers.id = provider_oauth.provider_id
        where provider_oauth.id = $1
          and provider_oauth.completed_at is not null
          and provider_oauth.encrypted_token is not null
          and provider_oauth.deleted_at is null
          and providers.deleted_at is null
      `,
      [input.providerOAuthId],
    );
    return toProviderOAuthRuntimeConnection(requireProviderOAuthRow(result.rows[0]));
  });
}

export async function readEnabledCompletedProviderOAuthConnections(input: {
  databaseUrl?: string;
  providerId: string;
}): Promise<ProviderOAuthRuntimeConnection[]> {
  return withPooledPostgresClient(input.databaseUrl, async (client) => {
    const result = await client.query<ProviderOAuthRuntimeRow>(
      `
        select provider_oauth.id::text,
               provider_oauth.provider_id::text,
               provider_oauth.label,
               provider_oauth.priority,
               provider_oauth.enabled,
               provider_oauth.encrypted_token,
               provider_oauth.token_expires_at,
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
          and provider_oauth.deleted_at is null
          and providers.deleted_at is null
        order by provider_oauth.priority asc,
                 provider_oauth.created_at asc,
                 provider_oauth.id asc
      `,
      [input.providerId],
    );
    return result.rows.map(toProviderOAuthRuntimeConnection);
  });
}

function toProviderOAuthMetadata(row: ProviderOAuthRow): ProviderOAuthMetadata {
  return {
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    id: row.id,
    label: row.label,
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
