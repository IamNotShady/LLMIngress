import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "@llmingress/db/console-provider-templates";
import { normalizeProviderFormInput } from "@llmingress/db/console-providers";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

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

  it("uses current-schema migration cleanup instead of a runtime removed-provider blacklist", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0049");
    const providersSource = readFileSync(
      join(process.cwd(), "packages/db/src/providers.ts"),
      "utf8",
    );
    const gatewaySource = readFileSync(
      join(process.cwd(), "packages/db/src/gateway-config-reload.ts"),
      "utf8",
    );

    expect(migration).toMatchObject({
      id: "0049",
      name: "remove_legacy_provider_keys",
    });
    expect(
      existsSync(
        join(process.cwd(), "packages/db/migrations/0049_remove_legacy_provider_keys.sql"),
      ),
    ).toBe(true);
    expect(providersSource).not.toContain("isRemovedProviderKey");
    expect(gatewaySource).not.toContain("isRemovedProviderKey");
  });
});
