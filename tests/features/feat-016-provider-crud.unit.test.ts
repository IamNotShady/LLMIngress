import {
  createProvider,
  deleteProvider,
  listProviders,
  normalizeProviderFormInput,
} from "@llmingress/db/console-providers";
import { describe, expect, it } from "vitest";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";

describe("feat-016 provider CRUD and enablement", () => {
  it("normalizes provider form input for persistence", () => {
    expect(
      normalizeProviderFormInput({
        baseUrl: " https://api.openai.com/v1 ",
        displayName: " OpenAI API ",
        providerKey: " OpenAI ",
        providerType: "api_key",
      }),
    ).toEqual({
      baseUrl: "https://api.openai.com/v1",
      defaultPriority: 100,
      displayName: "OpenAI API",
      providerKey: "openai",
      providerType: "api_key",
    });
  });

  it("rejects empty provider keys and unsupported provider types", () => {
    expect(() =>
      normalizeProviderFormInput({
        displayName: "OpenAI",
        providerKey: "",
        providerType: "api_key",
      }),
    ).toThrow(/provider key/i);

    expect(() =>
      normalizeProviderFormInput({
        displayName: "OpenAI",
        providerKey: "openai",
        providerType: "oauth",
      }),
    ).toThrow(/provider type/i);
  });

  it("rejects removed provider keys", () => {
    for (const providerKey of ["fireworks", "groq", "mistral"]) {
      expect(() =>
        normalizeProviderFormInput({
          baseUrl: "https://example.com/v1",
          displayName: providerKey,
          providerKey,
          providerType: "api_key",
        }),
      ).toThrow(/no longer supported/i);
    }
  });

  it("core provider schema supports listing edit and enablement fields", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0002");

    expect(migration?.sql).toContain("create table if not exists providers");
    expect(migration?.sql).toContain("provider_key text not null unique");
    expect(migration?.sql).toContain("display_name text not null");
    expect(migration?.sql).toContain("base_url text");
    expect(migration?.sql).toContain("enabled boolean not null default true");
  });

  it("deletes providers from console lists and removes provider-owned keys and models", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: "llmingress_provider_delete",
    });

    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const provider = await createProvider({
        databaseUrl: fixture.databaseUrl,
        provider: normalizeProviderFormInput({
          baseUrl: "https://api.openai.com/v1",
          displayName: "Provider to delete",
          providerKey: "openai",
          providerType: "api_key",
        }),
      });
      await fixture.query(
        `
          insert into provider_models (id, provider_id, model_id, display_name)
          values (gen_random_uuid(), $1, 'delete-test-model', 'delete-test-model')
        `,
        [provider.id],
      );
      await fixture.query(
        `
          insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
          values (gen_random_uuid(), $1, 'sk-test-', '{}'::jsonb, 'test-key')
        `,
        [provider.id],
      );

      await deleteProvider({ databaseUrl: fixture.databaseUrl, id: provider.id });

      await expect(listProviders(fixture.databaseUrl)).resolves.toEqual([]);
      await expect(
        fixture.query(
          "select count(*)::integer as count from provider_api_keys where provider_id = $1",
          [provider.id],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        fixture.query(
          "select deleted_at is not null as deleted from provider_models where provider_id = $1",
          [provider.id],
        ),
      ).resolves.toMatchObject({ rows: [{ deleted: true }] });
    } finally {
      await fixture.dispose();
    }
  });
});
