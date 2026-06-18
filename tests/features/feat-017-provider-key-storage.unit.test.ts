import { describe, expect, it } from "vitest";
import {
  prepareProviderApiKeyForStorage,
  toProviderApiKeyMetadata,
} from "../../apps/console/src/server/provider-keys";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { decryptSecret, loadMasterKey } from "../../packages/security/src/index";

describe("feat-017 provider key secure storage", () => {
  it("encrypts provider API key plaintext for storage and exposes metadata only", () => {
    const plaintext = "sk-live-provider-secret-017";
    const masterKeySource = {
      kind: "inline" as const,
      value: "feat-017-unit-master-key",
    };

    const stored = prepareProviderApiKeyForStorage({
      masterKeySource,
      plaintext,
    });

    expect(stored.keyPrefix).toBe("sk-live-");
    expect(stored.keyId).toBe(loadMasterKey(masterKeySource).keyId);
    expect(JSON.stringify(stored.encryptedKey)).not.toContain(plaintext);
    expect(decryptSecret(stored.encryptedKey, loadMasterKey(masterKeySource))).toBe(plaintext);

    const metadata = toProviderApiKeyMetadata({
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      enabled: true,
      id: "provider-key-017",
      key_id: stored.keyId,
      key_prefix: stored.keyPrefix,
      label: null,
      last_test_error_code: null,
      last_test_error_message: null,
      last_test_status: "untested",
      last_tested_at: null,
      last_used_at: null,
      priority: 100,
      provider_id: "provider-017",
      rotated_at: null,
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(metadata).toEqual({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      enabled: true,
      id: "provider-key-017",
      keyId: stored.keyId,
      keyPrefix: "sk-live-",
      label: null,
      lastTestErrorCode: null,
      lastTestErrorMessage: null,
      lastTestStatus: "untested",
      lastTestedAt: null,
      lastUsedAt: null,
      priority: 100,
      providerId: "provider-017",
      rotatedAt: null,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(JSON.stringify(metadata)).not.toContain(plaintext);
    expect(metadata).not.toHaveProperty("plaintext");
    expect(metadata).not.toHaveProperty("encryptedKey");
  });

  it("rejects provider API keys too short to expose as a safe prefix", () => {
    expect(() =>
      prepareProviderApiKeyForStorage({
        masterKeySource: {
          kind: "inline",
          value: "feat-017-unit-master-key",
        },
        plaintext: "short",
      }),
    ).toThrow(/longer than the stored prefix/i);
  });

  it("declares provider API key storage as ciphertext plus metadata without plaintext columns", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0006");

    expect(migration).toMatchObject({
      id: "0006",
      name: "provider_key_secure_storage",
    });

    const sql = migration?.sql ?? "";
    const tableSql = readCreateTableSql(sql, "provider_api_keys");

    expect(tableSql).toContain(
      "provider_id uuid not null unique references providers (id) on delete cascade",
    );
    expect(tableSql).toContain("key_prefix text not null");
    expect(tableSql).toContain("encrypted_key jsonb not null");
    expect(tableSql).toContain("key_id text not null");
    expect(tableSql).toContain("rotated_at timestamptz");
    expect(tableSql).not.toMatch(/\bplaintext\b/i);
    expect(tableSql).not.toMatch(/\bapi_key\b\s+text/i);
  });
});

function readCreateTableSql(sql: string, tableName: string): string {
  const match = new RegExp(`create table if not exists ${tableName} \\([\\s\\S]*?\\n\\);`).exec(
    sql,
  );
  if (!match?.[0]) {
    throw new Error(`Missing create table block for ${tableName}.`);
  }
  return match[0];
}
