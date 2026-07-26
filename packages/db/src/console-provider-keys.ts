import { randomUUID } from "node:crypto";
import { withPooledPostgresClient, withPostgresTransaction } from "@llmingress/db/client";
import { createConfigPublisher } from "@llmingress/db/config-versions";
import { clearProviderConnectionHealthWithClient } from "@llmingress/db/provider-health";
import { clearProviderQuotaWithClient } from "@llmingress/db/provider-quota";
import type { EncryptionKeySource } from "@llmingress/security/encryption-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { consoleNotFoundError, consoleValidationError } from "./console-operation-error.ts";

export type ProviderApiKeyMetadata = {
  createdAt: Date;
  enabled: boolean;
  id: string;
  keyId: string;
  keyPrefix: string;
  label: string | null;
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

export type ProviderApiKeyStorageRow = {
  created_at: Date;
  enabled: boolean;
  id: string;
  key_id: string;
  key_prefix: string;
  label: string | null;
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
  encryptionKeySource: EncryptionKeySource;
  plaintext: string;
}): StoredProviderApiKey {
  const plaintext = normalizeProviderApiKeyPlaintext(input.plaintext);
  const encryption = createSecretEncryption(input.encryptionKeySource);

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
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    priority: row.priority,
    providerId: row.provider_id,
    rotatedAt: row.rotated_at ? new Date(row.rotated_at) : null,
    updatedAt: new Date(row.updated_at),
  };
}

export function readConsoleEncryptionKeySource(
  env: Record<string, string | undefined> = process.env,
): EncryptionKeySource {
  const inlineKey = env.ENCRYPTION_KEY;
  if (inlineKey?.trim()) {
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.ENCRYPTION_KEY_FILE;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error("ENCRYPTION_KEY or ENCRYPTION_KEY_FILE is required for provider key storage.");
}

export async function listProviderApiKeyMetadata(
  databaseUrl?: string,
): Promise<ProviderApiKeyMetadata[]> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
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
               created_at,
               rotated_at,
               updated_at
        from provider_api_keys
        where deleted_at is null
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
  encryptionKeySource: EncryptionKeySource;
  plaintext: string;
  priority?: number;
  providerApiKeyId?: string;
  providerId: string;
}): Promise<ProviderApiKeySaveResult> {
  const stored = prepareProviderApiKeyForStorage({
    encryptionKeySource: input.encryptionKeySource,
    plaintext: input.plaintext,
  });
  const rowId = input.providerApiKeyId?.trim() || randomUUID();
  const action = input.providerApiKeyId ? "rotated" : "created";
  let metadata: ProviderApiKeyMetadata | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Save provider API key ${input.providerId}`,
    changes: [{ table: "provider_api_keys", recordId: rowId }],
    write: async (client) => {
      const provider = await client.query<{ provider_type: string }>(
        `
          select provider_type
          from providers
          where id = $1
            and deleted_at is null
          for update
        `,
        [input.providerId],
      );
      const providerType = provider.rows[0]?.provider_type;
      if (!providerType) {
        throw consoleNotFoundError("Provider was not found.", "provider_not_found", {
          providerId: input.providerId,
        });
      }
      if (providerType !== "api_key") {
        throw consoleValidationError(
          "Provider API keys can only be saved for API Key Providers.",
          "provider_api_key_unsupported",
          { providerId: input.providerId, providerType },
        );
      }
      const result = input.providerApiKeyId
        ? await client.query<ProviderApiKeyStorageRow>(
            `
              update provider_api_keys
              set key_prefix = $3,
                  encrypted_key = $4::jsonb,
                  key_id = $5,
                  label = $6,
                  enabled = $7,
                  priority = $8,
                  rotated_at = now(),
                  updated_at = now()
              where id = $1
                and provider_id = $2
                and deleted_at is null
              returning id::text,
                        provider_id::text,
                        key_prefix,
                        key_id,
                        label,
                        enabled,
                        priority,
                        last_used_at,
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
          )
        : await client.query<ProviderApiKeyStorageRow>(
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
      const row = requireProviderApiKeyRow(result.rows[0]);
      metadata = toProviderApiKeyMetadata(row);
      if (input.providerApiKeyId) {
        await clearProviderConnectionHealthWithClient(client, {
          providerConnectionId: row.id,
          providerId: row.provider_id,
        });
      }
    },
  });

  if (!metadata) {
    throw new Error("Provider API key was not saved.");
  }

  return { action, metadata };
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
          update provider_api_keys
          set deleted_at = now(),
              enabled = false,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning provider_id::text
        `,
        [input.providerApiKeyId],
      );
      providerId = result.rows[0]?.provider_id;
      if (providerId) {
        await clearProviderConnectionHealthWithClient(client, {
          providerConnectionId: input.providerApiKeyId,
          providerId,
        });
        await clearProviderQuotaWithClient(client, {
          providerConnectionId: input.providerApiKeyId,
          providerId,
        });
      }
    },
  });

  if (!providerId) {
    throw consoleNotFoundError("Provider API key was not found.", "provider_api_key_not_found");
  }
  return { providerId };
}

/**
 * The label and routing priority of a stored key. Rotating the secret is a
 * separate act — an operator changing a label should not have to produce a new
 * credential to do it.
 */
export async function updateProviderApiKeySettings(input: {
  databaseUrl?: string;
  enabled: boolean;
  label: string | null;
  priority: number;
  providerApiKeyId: string;
}): Promise<{ enabled: boolean; id: string; providerId: string }> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const result = await client.query<{ enabled: boolean; id: string; provider_id: string }>(
      `
        update provider_api_keys
        set label = $2,
            priority = $3,
            enabled = $4,
            updated_at = now()
        where id = $1
          and deleted_at is null
        returning enabled, id::text, provider_id::text
      `,
      // The same rules as the paste path: renaming a connection is not a way
      // past the label length or the 0-100 integer the column stores.
      [
        input.providerApiKeyId,
        normalizeOptionalLabel(input.label),
        normalizePriority(input.priority),
        input.enabled,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw consoleNotFoundError("Provider API key was not found.", "provider_api_key_not_found", {
        providerApiKeyId: input.providerApiKeyId,
      });
    }
    return { enabled: row.enabled, id: row.id, providerId: row.provider_id };
  });
}

export async function setProviderApiKeyQuotaProbeEnabled(input: {
  databaseUrl?: string;
  providerApiKeyId: string;
  quotaProbeEnabled: boolean;
}): Promise<{ id: string; providerId: string; quotaProbeEnabled: boolean }> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const result = await client.query<{
      id: string;
      provider_id: string;
      quota_probe_enabled: boolean;
    }>(
      `
        update provider_api_keys
        set quota_probe_enabled = $2,
            updated_at = now()
        where id = $1
          and deleted_at is null
        returning id::text, provider_id::text, quota_probe_enabled
      `,
      [input.providerApiKeyId, input.quotaProbeEnabled],
    );
    const row = result.rows[0];
    if (!row) {
      throw consoleNotFoundError("Provider API key was not found.", "provider_api_key_not_found", {
        providerApiKeyId: input.providerApiKeyId,
      });
    }
    if (input.quotaProbeEnabled) {
      // Pull the stored schedule up so the 5-minute scan probes promptly
      // instead of waiting out the previous next_refresh_at.
      await client.query(
        `
          update provider_quota_summary
          set next_refresh_at = now(),
              updated_at = now()
          where provider_id = $1
            and provider_connection_id = $2
        `,
        [row.provider_id, row.id],
      );
    }
    return {
      id: row.id,
      providerId: row.provider_id,
      quotaProbeEnabled: row.quota_probe_enabled,
    };
  });
}

export async function setProviderApiKeyEnabled(input: {
  databaseUrl?: string;
  enabled: boolean;
  providerApiKeyId: string;
}): Promise<ProviderApiKeyMetadata> {
  let metadata: ProviderApiKeyMetadata | undefined;
  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `${input.enabled ? "Enable" : "Disable"} provider API key ${input.providerApiKeyId}`,
    changes: [{ table: "provider_api_keys", recordId: input.providerApiKeyId }],
    write: async (client) => {
      const result = await client.query<ProviderApiKeyStorageRow>(
        `
          update provider_api_keys
          set enabled = $2,
              updated_at = now()
          where id = $1
            and deleted_at is null
          returning id::text,
                    provider_id::text,
                    key_prefix,
                    key_id,
                    label,
                    enabled,
                    priority,
                    last_used_at,
                    created_at,
                    rotated_at,
                    updated_at
        `,
        [input.providerApiKeyId, input.enabled],
      );
      const row = requireProviderApiKeyRow(result.rows[0]);
      metadata = toProviderApiKeyMetadata(row);
      await clearProviderConnectionHealthWithClient(client, {
        providerConnectionId: row.id,
        providerId: row.provider_id,
      });
    },
  });
  return requireProviderApiKeyRowMetadata(metadata);
}

function normalizeProviderApiKeyPlaintext(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw consoleValidationError("Provider API key is required.", "provider_api_key_required");
  }
  if (plaintext.length <= providerKeyPrefixLength) {
    throw consoleValidationError(
      "Provider API key must be longer than the stored prefix.",
      "provider_api_key_too_short",
    );
  }
  return plaintext;
}

function buildProviderKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, providerKeyPrefixLength);
}

function normalizeOptionalLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  if (label && label.length > providerApiKeyLabelMaxLength) {
    throw consoleValidationError(
      "Provider API key label must be at most 100 characters.",
      "provider_api_key_label_too_long",
    );
  }
  return label || null;
}

function normalizePriority(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isInteger(value) || value < 0 || value > providerApiKeyPriorityMax) {
    throw consoleValidationError(
      "Provider API key priority must be between 0 and 100.",
      "provider_api_key_priority_invalid",
    );
  }
  return value;
}

function requireProviderApiKeyRow(
  row: ProviderApiKeyStorageRow | undefined,
): ProviderApiKeyStorageRow {
  if (!row) {
    throw consoleNotFoundError("Provider API key was not found.", "provider_api_key_not_found");
  }
  return row;
}

function requireProviderApiKeyRowMetadata(
  metadata: ProviderApiKeyMetadata | undefined,
): ProviderApiKeyMetadata {
  if (!metadata) {
    throw consoleNotFoundError("Provider API key was not found.", "provider_api_key_not_found");
  }
  return metadata;
}
