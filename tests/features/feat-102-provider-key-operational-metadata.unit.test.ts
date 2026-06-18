import { describe, expect, it } from "vitest";
import { toProviderApiKeyMetadata } from "../../apps/console/src/server/provider-keys";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-102 provider key operational metadata", () => {
  it("declares provider priority and provider API key operational metadata schema", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0026" && candidate.name === "provider_key_operational_metadata",
    );

    expect(migration?.sql).toContain("alter table providers");
    expect(migration?.sql).toContain("default_priority integer not null default 100");
    expect(migration?.sql).toContain("alter table provider_api_keys");
    expect(migration?.sql).toContain("label text");
    expect(migration?.sql).toContain("enabled boolean not null default true");
    expect(migration?.sql).toContain("priority integer not null default 100");
    expect(migration?.sql).toContain("last_used_at timestamptz");
    expect(migration?.sql).toContain("last_tested_at timestamptz");
    expect(migration?.sql).toContain("last_test_status text not null default 'untested'");
    expect(migration?.sql).toContain("last_test_error_code text");
    expect(migration?.sql).toContain("last_test_error_message text");
    expect(migration?.sql).toContain("idx_provider_api_keys_provider_enabled_priority");
  });

  it("maps provider API key operational metadata without plaintext", () => {
    const createdAt = new Date("2026-06-18T01:00:00Z");
    const lastUsedAt = new Date("2026-06-18T01:05:00Z");
    const lastTestedAt = new Date("2026-06-18T01:10:00Z");
    const metadata = toProviderApiKeyMetadata({
      created_at: createdAt,
      enabled: false,
      id: "00000000-0000-4000-8000-000000000102",
      key_id: "key-id-102",
      key_prefix: "sk-unit",
      label: "Primary subscription",
      last_test_error_code: "invalid_api_key",
      last_test_error_message: "Invalid API key",
      last_test_status: "failed",
      last_tested_at: lastTestedAt,
      last_used_at: lastUsedAt,
      priority: 5,
      provider_id: "00000000-0000-4000-8000-000000001102",
      rotated_at: null,
      updated_at: createdAt,
    });

    expect(metadata).toEqual({
      createdAt,
      enabled: false,
      id: "00000000-0000-4000-8000-000000000102",
      keyId: "key-id-102",
      keyPrefix: "sk-unit",
      label: "Primary subscription",
      lastTestErrorCode: "invalid_api_key",
      lastTestErrorMessage: "Invalid API key",
      lastTestStatus: "failed",
      lastTestedAt,
      lastUsedAt,
      priority: 5,
      providerId: "00000000-0000-4000-8000-000000001102",
      rotatedAt: null,
      updatedAt: createdAt,
    });
    expect(metadata).not.toHaveProperty("plaintext");
    expect(metadata).not.toHaveProperty("encryptedKey");
  });
});
