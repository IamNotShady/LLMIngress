import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/providers";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";

export type ProviderApiKeyTestStatus =
  | "auth_failed"
  | "healthy"
  | "network_error"
  | "quota_limited"
  | "unknown"
  | "unhealthy";

export type ProviderApiKeyMetadata = {
  createdAt: Date;
  enabled: boolean;
  id: string;
  keyId: string;
  keyPrefix: string;
  label: string | null;
  lastTestErrorCode: string | null;
  lastTestErrorMessage: string | null;
  lastTestStatus: ProviderApiKeyTestStatus;
  lastTestedAt: Date | null;
  lastUsedAt: Date | null;
  priority: number;
  providerId: string;
  rotatedAt: Date | null;
  updatedAt: Date;
};

export type StoredProviderApiKey = {
  encryptedKey: EncryptedSecret;
  keyId: string;
  keyPrefix: string;
};

export type ProviderApiKeyStorageRow = PostgresQueryResultRow & {
  created_at: Date;
  enabled: boolean;
  id: string;
  key_id: string;
  key_prefix: string;
  label: string | null;
  last_test_error_code: string | null;
  last_test_error_message: string | null;
  last_test_status: ProviderApiKeyTestStatus;
  last_tested_at: Date | null;
  last_used_at: Date | null;
  priority: number;
  provider_id: string;
  rotated_at: Date | null;
  updated_at: Date;
};

type ProviderApiKeySaveResult = {
  action: "created" | "rotated";
  metadata: ProviderApiKeyMetadata;
};

const providerKeyPrefixLength = 8;
const providerApiKeyLabelMaxLength = 100;
const providerApiKeyPriorityMax = 100;

export function prepareProviderApiKeyForStorage(input: {
  masterKeySource: MasterKeySource;
  plaintext: string;
}): StoredProviderApiKey {
  const plaintext = normalizeProviderApiKeyPlaintext(input.plaintext);
  const encryption = createSecretEncryption(input.masterKeySource);

  return {
    encryptedKey: encryption.encrypt(plaintext),
    keyId: encryption.keyId,
    keyPrefix: buildProviderKeyPrefix(plaintext),
  };
}

export function toProviderApiKeyMetadata(row: ProviderApiKeyStorageRow): ProviderApiKeyMetadata {
  return {
    createdAt: new Date(row.created_at),
    enabled: row.enabled,
    id: row.id,
    keyId: row.key_id,
    keyPrefix: row.key_prefix,
    label: row.label,
    lastTestErrorCode: row.last_test_error_code,
    lastTestErrorMessage: row.last_test_error_message,
    lastTestStatus: row.last_test_status,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    priority: row.priority,
    providerId: row.provider_id,
    rotatedAt: row.rotated_at ? new Date(row.rotated_at) : null,
    updatedAt: new Date(row.updated_at),
  };
}

export function formatProviderApiKeyTestStatusLabel(status: ProviderApiKeyTestStatus): string {
  return {
    auth_failed: "Auth failed",
    healthy: "Healthy",
    network_error: "Network error",
    quota_limited: "Quota limited",
    unhealthy: "Unhealthy",
    unknown: "Unknown",
  }[status];
}

export function readConsoleMasterKeySource(
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

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required for provider key storage.");
}

export async function listProviderApiKeyMetadata(
  databaseUrl?: string,
): Promise<ProviderApiKeyMetadata[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<ProviderApiKeyStorageRow>(
      `
        select id::text,
               provider_id::text,
               key_prefix,
               key_id,
               label,
               enabled,
               priority,
               last_used_at,
               last_tested_at,
               last_test_status,
               last_test_error_code,
               last_test_error_message,
               created_at,
               rotated_at,
               updated_at
        from provider_api_keys
        order by provider_id,
                 priority,
                 created_at,
                 id
      `,
    );
    return result.rows.map(toProviderApiKeyMetadata);
  });
}

export async function saveProviderApiKey(input: {
  databaseUrl?: string;
  enabled?: boolean;
  label?: string | null;
  masterKeySource: MasterKeySource;
  plaintext: string;
  priority?: number;
  providerId: string;
}): Promise<ProviderApiKeySaveResult> {
  const stored = prepareProviderApiKeyForStorage({
    masterKeySource: input.masterKeySource,
    plaintext: input.plaintext,
  });
  const rowId = randomUUID();
  let metadata: ProviderApiKeyMetadata | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Save provider API key ${input.providerId}`,
    changes: [{ table: "provider_api_keys", recordId: rowId }],
    write: async (client) => {
      const result = await client.query<ProviderApiKeyStorageRow>(
        `
          insert into provider_api_keys (
            id,
            provider_id,
            key_prefix,
            encrypted_key,
            key_id,
            label,
            enabled,
            priority
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          returning id::text,
                    provider_id::text,
                    key_prefix,
                    key_id,
                    label,
                    enabled,
                    priority,
                    last_used_at,
                    last_tested_at,
                    last_test_status,
                    last_test_error_code,
                    last_test_error_message,
                    created_at,
                    rotated_at,
                    updated_at
        `,
        [
          rowId,
          input.providerId,
          stored.keyPrefix,
          JSON.stringify(stored.encryptedKey),
          stored.keyId,
          normalizeOptionalLabel(input.label),
          input.enabled ?? true,
          normalizePriority(input.priority),
        ],
      );
      metadata = toProviderApiKeyMetadata(requireProviderApiKeyRow(result.rows[0]));
    },
  });

  if (!metadata) {
    throw new Error("Provider API key was not saved.");
  }

  return { action: "created", metadata };
}

export async function updateProviderApiKeyMetadata(input: {
  databaseUrl?: string;
  enabled: boolean;
  label?: string | null;
  priority: number;
  providerApiKeyId: string;
}): Promise<ProviderApiKeyMetadata> {
  let metadata: ProviderApiKeyMetadata | undefined;
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update provider API key ${input.providerApiKeyId}`,
    changes: [{ table: "provider_api_keys", recordId: input.providerApiKeyId }],
    write: async (client) => {
      const result = await client.query<ProviderApiKeyStorageRow>(
        `
          update provider_api_keys
          set label = $2,
              enabled = $3,
              priority = $4,
              updated_at = now()
          where id = $1
          returning id::text,
                    provider_id::text,
                    key_prefix,
                    key_id,
                    label,
                    enabled,
                    priority,
                    last_used_at,
                    last_tested_at,
                    last_test_status,
                    last_test_error_code,
                    last_test_error_message,
                    created_at,
                    rotated_at,
                    updated_at
        `,
        [
          input.providerApiKeyId,
          normalizeOptionalLabel(input.label),
          input.enabled,
          normalizePriority(input.priority),
        ],
      );
      metadata = toProviderApiKeyMetadata(requireProviderApiKeyRow(result.rows[0]));
    },
  });

  if (!metadata) {
    throw new Error("Provider API key metadata was not updated.");
  }
  return metadata;
}

export async function deleteProviderApiKey(input: {
  databaseUrl?: string;
  providerApiKeyId: string;
}): Promise<{ providerId: string }> {
  let providerId: string | undefined;
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Delete provider API key ${input.providerApiKeyId}`,
    changes: [{ table: "provider_api_keys", recordId: input.providerApiKeyId }],
    write: async (client) => {
      const result = await client.query<{ provider_id: string }>(
        `
          delete from provider_api_keys
          where id = $1
          returning provider_id::text
        `,
        [input.providerApiKeyId],
      );
      providerId = result.rows[0]?.provider_id;
    },
  });

  if (!providerId) {
    throw new Error("Provider API key was not found.");
  }
  return { providerId };
}

function normalizeProviderApiKeyPlaintext(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw new Error("Provider API key is required.");
  }
  if (plaintext.length <= providerKeyPrefixLength) {
    throw new Error("Provider API key must be longer than the stored prefix.");
  }
  return plaintext;
}

function buildProviderKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, providerKeyPrefixLength);
}

function normalizeOptionalLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (label && label.length > providerApiKeyLabelMaxLength) {
    throw new Error("Provider API key label must be at most 100 characters.");
  }
  return label || null;
}

function normalizePriority(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isInteger(value) || value < 0 || value > providerApiKeyPriorityMax) {
    throw new Error("Provider API key priority must be between 0 and 100.");
  }
  return value;
}

function requireProviderApiKeyRow(
  row: ProviderApiKeyStorageRow | undefined,
): ProviderApiKeyStorageRow {
  if (!row) {
    throw new Error("Provider API key was not found.");
  }
  return row;
}

async function withClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
