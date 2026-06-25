import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";

const remoteTemplateExpectations = [
  ["deepseek", "DeepSeek", "https://api.deepseek.com"],
  ["xai", "xAI", "https://api.x.ai/v1"],
  ["qwen", "Qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  ["moonshot", "Moonshot/Kimi", "https://api.moonshot.ai/v1"],
  ["minimax", "MiniMax", "https://api.minimax.io/v1"],
  ["zai", "Z.ai", "https://api.z.ai/api/paas/v4"],
] as const;

const removedRemoteTemplateIds = ["fireworks", "groq", "mistral"] as const;

describe("feat-063 remote OpenAI-compatible templates", () => {
  it("defines supported remote templates with fixed URLs capabilities and bearer auth behavior", () => {
    expect(listOpenAICompatibleProviderTemplates()).toEqual(
      remoteTemplateExpectations.map(([id, displayName, baseUrl]) => ({
        auth: {
          header: "Authorization",
          scheme: "Bearer",
        },
        baseUrl,
        capabilities: {
          chatCompletions: true,
          streaming: true,
          tools: true,
        },
        displayName,
        id,
        providerKey: id,
        providerType: "api_key",
      })),
    );
  });

  it("does not expose removed remote provider templates", () => {
    const remoteGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );

    expect(listOpenAICompatibleProviderTemplates().map((template) => template.id)).not.toEqual(
      expect.arrayContaining([...removedRemoteTemplateIds]),
    );
    expect(remoteGroup?.templates.map((template) => template.id)).not.toEqual(
      expect.arrayContaining([...removedRemoteTemplateIds]),
    );
    for (const id of removedRemoteTemplateIds) {
      expect(() => normalizeProviderTemplateFormInput({ templateId: id })).toThrow(/whitelisted/i);
    }
  });

  it("normalizes each remote template and rejects legacy or arbitrary endpoint creation", () => {
    for (const [id, displayName, baseUrl] of remoteTemplateExpectations) {
      expect(getOpenAICompatibleProviderTemplate(id)).toMatchObject({
        baseUrl,
        displayName,
        id,
        providerKey: id,
        providerType: "api_key",
      });
      expect(normalizeProviderTemplateFormInput({ templateId: id })).toMatchObject({
        baseUrl,
        providerKey: id,
        providerType: "api_key",
      });
      expect(() =>
        normalizeProviderTemplateFormInput({
          baseUrl: "https://arbitrary.example/v1",
          templateId: id,
        }),
      ).toThrow(/custom OpenAI-compatible endpoints are not allowed/i);
      expect(() =>
        normalizeProviderFormInput({
          baseUrl,
          displayName,
          providerKey: id,
          providerType: "api_key",
        }),
      ).toThrow(/template/i);
    }
  });

  it("exposes all remote templates through the selector group with fixed URL and auth metadata", () => {
    const remoteGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );

    expect(remoteGroup?.templates).toEqual(
      expect.arrayContaining(
        remoteTemplateExpectations.map(([id, displayName, baseUrl]) => ({
          auth: {
            header: "Authorization",
            scheme: "Bearer",
          },
          baseUrlMode: "fixed_remote",
          capabilities: ["chat_completions", "streaming", "tools"],
          displayName,
          fixedBaseUrl: baseUrl,
          id,
          providerKey: id,
          providerType: "api_key",
        })),
      ),
    );
  });

  it("removes unsupported remote template ids from the active database constraint", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0042");

    expect(migration).toMatchObject({
      id: "0042",
      name: "remove_unsupported_remote_provider_templates",
    });
    for (const [id] of remoteTemplateExpectations) {
      expect(migration?.sql).toContain(`'${id}'`);
    }
    expect(migration?.sql).toContain("'ollama'");
    expect(migration?.sql).toContain("not valid");
    for (const id of removedRemoteTemplateIds) {
      expect(migration?.sql).not.toContain(`'${id}'`);
    }
  });

  it("excludes legacy removed provider keys from the Gateway config snapshot", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_removed_provider_${randomUUID().replaceAll("-", "_")}`,
    });

    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });

      const providerId = randomUUID();
      const providerModelId = randomUUID();
      const virtualModelId = randomUUID();
      const routePolicyId = randomUUID();
      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'api_key', 'groq', 'Legacy Groq', 'https://api.groq.com/openai/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_models (
            id,
            provider_id,
            model_id,
            display_name,
            context_window,
            supports_streaming,
            supports_tools,
            availability
          )
          values ($1, $2, 'llama-3.1', 'Llama 3.1', 128000, true, true, 'available')
        `,
        [providerModelId, providerId],
      );
      await fixture.query(
        `
          insert into virtual_models (id, name, description, enabled)
          values ($1, 'removed-provider-vm', 'Removed provider VM', true)
        `,
        [virtualModelId],
      );
      await fixture.query(
        `
          insert into route_policies (id, virtual_model_id, strategy)
          values ($1, $2, 'fixed')
        `,
        [routePolicyId, virtualModelId],
      );
      await fixture.query(
        `
          insert into route_policy_candidates (
            id,
            route_policy_id,
            provider_model_id,
            candidate_order
          )
          values ($1, $2, $3, 1)
        `,
        [randomUUID(), routePolicyId, providerModelId],
      );

      const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);

      expect(snapshot.providers.map((provider) => provider.providerKey)).not.toContain("groq");
      expect(snapshot.routePolicies).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
