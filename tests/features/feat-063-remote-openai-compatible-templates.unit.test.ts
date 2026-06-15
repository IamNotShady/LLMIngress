import { describe, expect, it } from "vitest";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";

const remoteTemplateExpectations = [
  ["deepseek", "DeepSeek", "https://api.deepseek.com"],
  ["xai", "xAI", "https://api.x.ai/v1"],
  ["mistral", "Mistral", "https://api.mistral.ai/v1"],
  ["qwen", "Qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  ["moonshot", "Moonshot/Kimi", "https://api.moonshot.ai/v1"],
  ["minimax", "MiniMax", "https://api.minimax.io/v1"],
  ["groq", "Groq", "https://api.groq.com/openai/v1"],
  ["fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1"],
  ["zai", "Z.ai", "https://api.z.ai/api/paas/v4"],
] as const;

describe("feat-063 remote OpenAI-compatible templates", () => {
  it("defines all nine remote templates with fixed URLs capabilities and bearer auth behavior", () => {
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

  it("declares all remote template ids in the active database constraint", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0009");

    expect(migration).toMatchObject({
      id: "0009",
      name: "remote_openai_compatible_templates",
    });
    for (const [id] of remoteTemplateExpectations) {
      expect(migration?.sql).toContain(`'${id}'`);
    }
    expect(migration?.sql).toContain("'ollama'");
  });
});
