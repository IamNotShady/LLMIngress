import { describe, expect, it } from "vitest";
import {
  isKnownProviderTemplateKey,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../packages/db/src/console-provider-templates";

const chatEndpoint = { method: "POST", path: "chat/completions" };
const embeddingsEndpoint = { method: "POST", path: "embeddings" };
const messagesEndpoint = { method: "POST", path: "messages" };
const modelsEndpoint = { method: "GET", path: "models" };
const responsesEndpoint = { method: "POST", path: "responses" };

describe("console provider template registry", () => {
  it("lists provider templates from a single endpoint-shaped contract", () => {
    const groups = listProviderTemplateSelectorGroups();

    expect(groups.map((group) => group.id)).toEqual(["subscription", "remote_api_key", "local"]);
    expect(groups.map((group) => group.templates.map((template) => template.id))).toEqual([
      ["openai_codex", "claude_code"],
      ["google", "openrouter", "deepseek", "xai", "qwen", "moonshot", "minimax", "zai"],
      ["ollama", "lmstudio", "llama_cpp"],
    ]);

    for (const group of groups) {
      for (const template of group.templates) {
        expect(isKnownProviderTemplateKey(template.id)).toBe(true);
        expect(template).toHaveProperty("endpoints");
        expect(template).not.toHaveProperty("capabilities");
      }
    }
    expect(isKnownProviderTemplateKey("future-provider")).toBe(false);
  });

  it("describes remote API key providers with editable default URLs and endpoints", () => {
    const remote = readTemplate("remote_api_key", "google");

    expect(remote).toMatchObject({
      baseUrlMode: "user_remote",
      displayName: "Google Gemini",
      endpoints: {
        chat_completions: chatEndpoint,
        embeddings: embeddingsEndpoint,
        models: modelsEndpoint,
      },
      fixedBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      providerKey: "google",
      providerType: "api_key",
    });
  });

  it("keeps local providers user-local and moves paths under endpoints", () => {
    const local = readTemplate("local", "ollama");

    expect(local).toMatchObject({
      baseUrlMode: "user_local_private",
      baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
      endpoints: {
        chat_completions: chatEndpoint,
        embeddings: embeddingsEndpoint,
        messages: messagesEndpoint,
        models: modelsEndpoint,
        responses: responsesEndpoint,
      },
      providerKey: "ollama",
      providerType: "local",
    });
    expect(() => normalizeProviderTemplateFormInput({ templateId: "ollama" })).toThrow(
      /base URL is required/,
    );
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://127.0.0.1:11434/v1/",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      id: "ollama",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });
  });

  it("keeps subscription protocol paths fixed while allowing custom API roots", () => {
    const subscription = readTemplate("subscription", "openai_codex");
    const claudeCode = readTemplate("subscription", "claude_code");

    expect(subscription).toMatchObject({
      baseUrlMode: "user_remote",
      endpoints: {
        models: { method: "GET", path: "codex/models" },
        responses: { method: "POST", path: "codex/responses" },
      },
      fixedBaseUrl: "https://chatgpt.com/backend-api",
      providerKey: "openai_codex",
      providerType: "subscription",
    });
    expect(claudeCode).toMatchObject({
      fixedBaseUrl: "https://api.anthropic.com",
      endpoints: {
        messages: { method: "POST", path: "v1/messages" },
        models: { method: "GET", path: "v1/models" },
      },
      providerKey: "claude_code",
    });
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://example.com/codex",
        templateId: "openai_codex",
      }).baseUrl,
    ).toBe("https://example.com/codex");
  });

  it("keeps long-tail OpenAI-compatible list scoped to long-tail providers", () => {
    const templates = listOpenAICompatibleProviderTemplates();

    expect(templates.map((template) => template.id)).toEqual([
      "deepseek",
      "xai",
      "qwen",
      "moonshot",
      "minimax",
      "zai",
    ]);
    for (const template of templates) {
      expect(template.endpoints).toEqual({
        chat_completions: chatEndpoint,
        models: modelsEndpoint,
        ...(template.id === "xai" || template.id === "qwen" || template.id === "minimax"
          ? { responses: responsesEndpoint }
          : {}),
      });
      expect(template).not.toHaveProperty("capabilities");
    }
  });

  it("records provider-documented endpoint subsets for routed template providers", () => {
    expect(readTemplate("remote_api_key", "openrouter").endpoints).toEqual({
      chat_completions: chatEndpoint,
      embeddings: embeddingsEndpoint,
      messages: messagesEndpoint,
      models: modelsEndpoint,
      responses: responsesEndpoint,
    });
    expect(readTemplate("remote_api_key", "moonshot").endpoints).toEqual({
      chat_completions: chatEndpoint,
      models: modelsEndpoint,
    });
    expect(readTemplate("remote_api_key", "zai").endpoints).toEqual({
      chat_completions: chatEndpoint,
      models: modelsEndpoint,
    });
    expect(readTemplate("local", "lmstudio").endpoints).toEqual({
      chat_completions: chatEndpoint,
      embeddings: embeddingsEndpoint,
      messages: messagesEndpoint,
      models: modelsEndpoint,
      responses: responsesEndpoint,
    });
  });
});

function readTemplate(groupId: string, templateId: string) {
  const group = listProviderTemplateSelectorGroups().find((entry) => entry.id === groupId);
  const template = group?.templates.find((entry) => entry.id === templateId);
  if (!template) {
    throw new Error(`Missing template ${groupId}/${templateId}`);
  }
  return template;
}
