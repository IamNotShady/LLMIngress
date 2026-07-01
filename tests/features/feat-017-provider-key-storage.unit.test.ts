import { randomUUID } from "node:crypto";
import {
  deleteProviderApiKey,
  prepareProviderApiKeyForStorage,
  saveProviderApiKey,
  toProviderApiKeyMetadata,
} from "@llmingress/db/console-provider-keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";
import { loadMasterKey } from "../../packages/security/src/master-key";
import { decryptSecret } from "../../packages/security/src/secret-encryption";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-017 provider key secure storage", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

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
      last_test_status: "unknown",
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
      lastTestStatus: "unknown",
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

  it("adds multiple provider API keys for the same provider", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_provider_multi_key_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, 'Multi Key Provider', 'https://example.com/v1', true)
      `,
      [providerId, `multi-key-${randomUUID()}`],
    );

    const first = await saveProviderApiKey({
      databaseUrl: fixture.databaseUrl,
      masterKeySource: {
        kind: "inline",
        value: "feat-017-multi-provider-key-master-key",
      },
      plaintext: "sk-first-provider-key-017",
      providerId,
    });
    const second = await saveProviderApiKey({
      databaseUrl: fixture.databaseUrl,
      masterKeySource: {
        kind: "inline",
        value: "feat-017-multi-provider-key-master-key",
      },
      plaintext: "sk-second-provider-key-017",
      providerId,
    });

    expect(first.action).toBe("created");
    expect(second.action).toBe("created");
    expect(first.metadata.id).not.toBe(second.metadata.id);

    const rows = await fixture.query<{ key_prefix: string; rotated_at: Date | null }>(
      `
        select key_prefix, rotated_at
        from provider_api_keys
        where provider_id = $1
        order by created_at, id
      `,
      [providerId],
    );
    expect(rows.rows).toEqual([
      { key_prefix: "sk-first", rotated_at: null },
      { key_prefix: "sk-secon", rotated_at: null },
    ]);
  });

  it("validates provider API key label length and priority range", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_provider_key_validation_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, 'Validation Provider', 'https://example.com/v1', true)
      `,
      [providerId, `validation-key-${randomUUID()}`],
    );

    const input = {
      databaseUrl: fixture.databaseUrl,
      masterKeySource: {
        kind: "inline" as const,
        value: "feat-017-validation-provider-key-master-key",
      },
      plaintext: "sk-validation-provider-key-017",
      providerId,
    };

    await expect(saveProviderApiKey({ ...input, label: "x".repeat(101) })).rejects.toThrow(
      /label must be at most 100 characters/i,
    );
    await expect(saveProviderApiKey({ ...input, priority: 101 })).rejects.toThrow(
      /priority must be between 0 and 100/i,
    );
  });

  it("deletes provider API keys and publishes the config change", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_provider_key_delete_unit_${randomUUID().replaceAll(
        "-",
        "_",
      )}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, 'Delete Key Provider', 'https://example.com/v1', true)
      `,
      [providerId, `delete-key-${randomUUID()}`],
    );

    const saved = await saveProviderApiKey({
      databaseUrl: fixture.databaseUrl,
      masterKeySource: {
        kind: "inline",
        value: "feat-017-delete-provider-key-master-key",
      },
      plaintext: "sk-delete-provider-key-017",
      providerId,
    });

    await expect(
      deleteProviderApiKey({
        databaseUrl: fixture.databaseUrl,
        providerApiKeyId: saved.metadata.id,
      }),
    ).resolves.toEqual({ providerId });

    const remainingKeys = await fixture.query<{ count: string }>(
      "select count(*)::text from provider_api_keys where id = $1",
      [saved.metadata.id],
    );
    expect(remainingKeys.rows[0]?.count).toBe("0");

    const configVersions = await fixture.query<{ changes: unknown; description: string }>(
      `
        select description, changes
        from config_versions
        order by version desc
        limit 1
      `,
    );
    expect(configVersions.rows[0]?.description).toBe(
      `Delete provider API key ${saved.metadata.id}`,
    );
    expect(configVersions.rows[0]?.changes).toEqual([
      expect.objectContaining({
        recordId: saved.metadata.id,
        source: "console",
        table: "provider_api_keys",
      }),
    ]);
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
