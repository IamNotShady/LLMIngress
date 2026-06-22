import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportConsoleConfig,
  importConsoleConfig,
  type LlmIngressConfigExport,
} from "../../apps/console/src/server/import-export";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-080 config import export", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("exports redacted config and round trips supported configuration through import", async () => {
    const source = await createFixture("source");
    const target = await createFixture("target");
    fixtures.push(source, target);

    await seedConfigExportData(source);

    const exported = await exportConsoleConfig({
      databaseUrl: source.databaseUrl,
      now: new Date("2026-06-16T12:00:00.000Z"),
    });
    const rawExport = JSON.stringify(exported);

    expect(exported).toMatchObject({
      exportedAt: "2026-06-16T12:00:00.000Z",
      kind: "llmingress.config.export",
      version: 1,
    });
    expect(rawExport).toContain("redacted");
    expect(rawExport).toContain("llmi_cfg80");
    expect(rawExport).toContain("sk-cfg80");
    expect(rawExport).not.toContain("ciphertext-config-export-080");
    expect(rawExport).not.toContain("sha256:v1:config-export-secret-hash-080");
    expect(rawExport).not.toContain("plaintext");

    const sameDatabaseImport = await importConsoleConfig({
      databaseUrl: source.databaseUrl,
      document: exported,
    });
    expect(sameDatabaseImport.version).toBe(1);
    const preservedAgentKey = await source.query<{ key_hash: string }>(
      "select key_hash from agents where key_prefix = 'llmi_cfg80'",
    );
    expect(preservedAgentKey.rows[0]?.key_hash).toBe("sha256:v1:config-export-secret-hash-080");

    const importResult = await importConsoleConfig({
      databaseUrl: target.databaseUrl,
      document: exported,
    });
    expect(importResult).toMatchObject({
      importedAgentCount: 1,
      importedAgentKeyCount: 1,
      importedProviderCount: 1,
      importedProviderModelCount: 1,
      importedRoutePolicyCount: 1,
      importedVirtualModelCount: 1,
      version: 1,
    });

    const targetExport = await exportConsoleConfig({
      databaseUrl: target.databaseUrl,
      now: new Date("2026-06-16T12:05:00.000Z"),
    });
    expect(stripVolatileAndProviderSecrets(targetExport)).toEqual(
      stripVolatileAndProviderSecrets(exported),
    );

    const importedProviderSecrets = await target.query<{ count: string }>(
      "select count(*)::text from provider_api_keys",
    );
    expect(importedProviderSecrets.rows[0]?.count).toBe("0");

    const importedAgentKey = await target.query<{ key_hash: string }>(
      "select key_hash from agents where key_prefix = 'llmi_cfg80'",
    );
    expect(importedAgentKey.rows[0]?.key_hash).toMatch(/^redacted-import:v1:/);
    expect(importedAgentKey.rows[0]?.key_hash).not.toBe("sha256:v1:config-export-secret-hash-080");

    const configVersions = await target.query<{ description: string; version: number }>(
      "select version, description from config_versions order by version",
    );
    expect(configVersions.rows).toEqual([
      {
        description: "Import redacted configuration",
        version: 1,
      },
    ]);
  });

  it("rejects imported providers with unknown templates before publishing a config version", async () => {
    const source = await createFixture("invalid_source");
    const target = await createFixture("invalid_target");
    fixtures.push(source, target);

    await seedConfigExportData(source);
    const exported = await exportConsoleConfig({
      databaseUrl: source.databaseUrl,
      now: new Date("2026-06-16T12:00:00.000Z"),
    });
    const invalid: LlmIngressConfigExport = {
      ...exported,
      providers: [
        {
          ...exported.providers[0],
          providerTemplateId: "not_whitelisted",
        },
      ],
    };

    await expect(
      importConsoleConfig({
        databaseUrl: target.databaseUrl,
        document: invalid,
      }),
    ).rejects.toThrow(/whitelisted provider template/i);

    const configVersions = await target.query<{ count: string }>(
      "select count(*)::text from config_versions",
    );
    expect(configVersions.rows[0]?.count).toBe("0");
  });

  it("imports local template providers without public network gating", async () => {
    const source = await createFixture("local_public_source");
    const target = await createFixture("local_public_target");
    fixtures.push(source, target);

    await seedConfigExportData(source);
    const exported = await exportConsoleConfig({
      databaseUrl: source.databaseUrl,
      now: new Date("2026-06-16T12:00:00.000Z"),
    });
    const publicLocalExport: LlmIngressConfigExport = {
      ...exported,
      providers: exported.providers.map((provider) => ({
        ...provider,
        baseUrl: "https://lmstudio.example.com/v1",
        displayName: "LM Studio Public",
        providerKey: "lmstudio",
        providerTemplateId: "lmstudio",
        providerType: "local",
      })),
    };

    await expect(
      importConsoleConfig({
        databaseUrl: target.databaseUrl,
        document: publicLocalExport,
      }),
    ).resolves.toMatchObject({
      importedProviderCount: 1,
      importedProviderModelCount: 1,
    });

    const providers = await target.query<{
      base_url: string;
      provider_key: string;
      provider_template_id: string;
      provider_type: string;
    }>(
      `
        select provider_type, provider_key, base_url, provider_template_id
        from providers
        where provider_key = 'lmstudio'
      `,
    );
    expect(providers.rows).toEqual([
      {
        base_url: "https://lmstudio.example.com/v1",
        provider_key: "lmstudio",
        provider_template_id: "lmstudio",
        provider_type: "local",
      },
    ]);
  });
});

async function createFixture(suffix: string): Promise<Fixture> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_config_import_export_${suffix}_${randomUUID().replaceAll("-", "_")}`,
  });
  await runMigrations({ databaseUrl: fixture.databaseUrl });
  return fixture;
}

async function seedConfigExportData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: "00000000-0000-4000-8000-000000000080",
    agentId: "00000000-0000-4000-8000-000000000080",
    providerApiKeyId: "00000000-0000-4000-8000-000000000680",
    providerId: "00000000-0000-4000-8000-000000000280",
    providerModelId: "00000000-0000-4000-8000-000000000380",
    routePolicyId: "00000000-0000-4000-8000-000000000580",
    virtualModelId: "00000000-0000-4000-8000-000000000480",
  };

  await fixture.query(
    `
      insert into providers (
        id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled
      )
      values ($1, 'api_key', 'deepseek', 'deepseek', 'Config Export DeepSeek',
              'https://api.deepseek.com', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id, provider_id, model_id, display_name, context_window, supports_streaming,
        supports_tools, availability
      )
      values ($1, $2, 'deepseek-chat', 'DeepSeek Chat', 64000, true, true, 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (
        id, provider_id, key_prefix, encrypted_key, key_id
      )
      values ($1, $2, 'sk-cfg80',
              '{"ciphertext":"ciphertext-config-export-080","iv":"iv","tag":"tag"}'::jsonb,
              'provider-key-id-080')
    `,
    [ids.providerApiKeyId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'config-fast', 'Config Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
    [ids.routePolicyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id, route_policy_id, provider_model_id, candidate_order, is_fallback
      )
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), ids.routePolicyId, ids.providerModelId],
  );
  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, 'Config Agent', 'coding', 'llmi_cfg80', 'sha256:v1:config-export-secret-hash-080', $2, true)
    `,
    [ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [ids.agentApiKeyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_limits (
        id, agent_id, limit_type, period, limit_value, unit, enabled
      )
      values ($1, $2, 'budget', 'month', 25.5, 'usd', true),
             ($3, $2, 'rpm', 'minute', 60, 'requests', true)
    `,
    [randomUUID(), ids.agentApiKeyId, randomUUID()],
  );
}

function stripVolatileAndProviderSecrets(exported: LlmIngressConfigExport): LlmIngressConfigExport {
  return {
    ...exported,
    exportedAt: "<exported-at>",
    providers: exported.providers.map((provider) => ({
      ...provider,
      providerApiKeys: [],
    })),
  };
}
