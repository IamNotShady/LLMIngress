import { randomUUID } from "node:crypto";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { Client, type QueryResultRow } from "pg";

export type ProviderApiKeyTestStatus = "failed" | "healthy" | "untested";

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

export type ProviderApiKeyStorageRow = QueryResultRow & {
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
  databaseUrl: string,
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
  databaseUrl: string;
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
  let action: ProviderApiKeySaveResult["action"] | undefined;
  let metadata: ProviderApiKeyMetadata | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Save provider API key ${input.providerId}`,
    changes: [{ table: "provider_api_keys", recordId: input.providerId }],
    write: async (client) => {
      const existing = await client.query<{ id: string }>(
        "select id::text from provider_api_keys where provider_id = $1 for update",
        [input.providerId],
      );
      const existingId = existing.rows[0]?.id;

      if (existingId) {
        const result = await client.query<ProviderApiKeyStorageRow>(
          `
            update provider_api_keys
            set key_prefix = $2,
                encrypted_key = $3,
                key_id = $4,
                label = $5,
                enabled = $6,
                priority = $7,
                rotated_at = now(),
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
            existingId,
            stored.keyPrefix,
            JSON.stringify(stored.encryptedKey),
            stored.keyId,
            normalizeOptionalLabel(input.label),
            input.enabled ?? true,
            normalizePriority(input.priority),
          ],
        );
        action = "rotated";
        metadata = toProviderApiKeyMetadata(requireProviderApiKeyRow(result.rows[0]));
        return;
      }

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
      action = "created";
      metadata = toProviderApiKeyMetadata(requireProviderApiKeyRow(result.rows[0]));
    },
  });

  if (!action || !metadata) {
    throw new Error("Provider API key was not saved.");
  }

  return { action, metadata };
}

export async function updateProviderApiKeyMetadata(input: {
  databaseUrl: string;
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
  return label || null;
}

function normalizePriority(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Provider API key priority must be a non-negative integer.");
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
