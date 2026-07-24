import { describe, expect, it } from "vitest";
import { listProviderTemplateEntries } from "../../packages/config/src/provider-registry";
import {
  getAnthropicCompatibleProviderTemplate,
  isAnthropicCompatibleProviderTemplateId,
  isKnownProviderTemplateKey,
  listAnthropicCompatibleProviderTemplates,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../packages/db/src/console-provider-templates";

const chatEndpoint = { method: "POST", path: "chat/completions" };
const messagesEndpoint = { method: "POST", path: "messages" };
const modelsEndpoint = { method: "GET", path: "models" };
const responsesEndpoint = { method: "POST", path: "responses" };

describe("console provider template registry", () => {
  it("lists provider templates from a single endpoint-shaped contract", () => {
    const groups = listProviderTemplateSelectorGroups();

    expect(groups.map((group) => group.id)).toEqual(["subscription", "remote_api_key", "local"]);
    expect(groups.map((group) => group.templates.map((template) => template.id))).toEqual([
      ["openai_codex", "claude_code", "minimax_coding"],
      [
        "google",
        "openrouter",
        "deepseek",
        "xai",
        "qwen",
        "qwen_token_plan",
        "moonshot",
        "kimi_coding",
        "minimax",
        "zai",
        "glm_coding",
        "command_code",
        "cline_pass",
        "byteplus_coding",
        "nous",
        "mistral",
        "groq",
        "cerebras",
        "fireworks",
        "nvidia",
        "xiaomi",
        "ollama_cloud",
        "opencode_go",
        "xiaomi_token_plan",
        "mistral_vibe",
      ],
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

  it("derives selector groups directly from the provider registry template entries", () => {
    const groups = listProviderTemplateSelectorGroups();
    const registryTemplateKeys = listProviderTemplateEntries().map((entry) => entry.providerKey);

    // Every selector template is a registry template entry, and vice versa.
    expect(
      groups.flatMap((group) => group.templates.map((template) => template.id)).sort(),
    ).toEqual([...registryTemplateKeys].sort());
    for (const group of groups) {
      for (const template of group.templates) {
        const entry = listProviderTemplateEntries().find(
          (candidate) => candidate.providerKey === template.id,
        );
        expect(entry).toBeDefined();
        expect(template.displayName).toBe(entry?.displayName);
        expect(template.providerType).toBe(entry?.providerType);
        // The routable endpoints survive; the models catalog is folded back in.
        for (const protocol of Object.keys(entry?.endpoints ?? {})) {
          expect(template.endpoints).toHaveProperty(protocol);
        }
        expect(template.endpoints).toHaveProperty("models");
      }
    }
  });

  it("describes remote API key providers with editable default URLs and endpoints", () => {
    const remote = readTemplate("remote_api_key", "google");

    expect(remote).toMatchObject({
      baseUrlMode: "user_remote",
      displayName: "Google Gemini",
      endpoints: {
        chat_completions: chatEndpoint,
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
        displayName: "  Local Ollama  ",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      displayName: "Local Ollama",
      id: "ollama",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });
    expect(() =>
      normalizeProviderTemplateFormInput({
        baseUrl: "http://127.0.0.1:11434/v1",
        displayName: "   ",
        templateId: "ollama",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "provider_display_name_required",
        details: { field: "displayName" },
        kind: "validation",
      }),
    );
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
    // MiniMax Coding Plan is the first subscription-type coding plan (device
    // code OAuth), distinct from the Batch 1 paste-key coding plans.
    expect(readTemplate("subscription", "minimax_coding")).toMatchObject({
      baseUrlMode: "user_remote",
      fixedBaseUrl: "https://api.minimax.io/anthropic/v1",
      endpoints: {
        messages: messagesEndpoint,
        models: modelsEndpoint,
      },
      providerKey: "minimax_coding",
      providerType: "subscription",
    });
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://example.com/codex",
        displayName: "OpenAI Codex",
        templateId: "openai_codex",
      }).baseUrl,
    ).toBe("https://example.com/codex");
  });

  it("registers a whitelisted anthropic-compatible template category for kimi_coding (W1)", () => {
    const templates = listAnthropicCompatibleProviderTemplates();
    expect(templates.map((template) => template.id)).toEqual(["kimi_coding"]);
    expect(templates[0]).toMatchObject({
      auth: { header: "x-api-key", scheme: "" },
      baseUrl: "https://api.kimi.com/coding/v1",
      endpoints: {
        messages: messagesEndpoint,
        models: modelsEndpoint,
      },
      id: "kimi_coding",
      providerKey: "kimi_coding",
      providerType: "api_key",
    });

    expect(isAnthropicCompatibleProviderTemplateId("kimi_coding")).toBe(true);
    expect(isAnthropicCompatibleProviderTemplateId("moonshot")).toBe(false);
    expect(isAnthropicCompatibleProviderTemplateId(null)).toBe(false);

    expect(getAnthropicCompatibleProviderTemplate("kimi_coding").providerKey).toBe("kimi_coding");
    expect(() => getAnthropicCompatibleProviderTemplate("moonshot")).toThrow(
      /whitelisted provider template/,
    );

    // The category is distinct from the OpenAI-compatible list.
    expect(listOpenAICompatibleProviderTemplates().map((template) => template.id)).not.toContain(
      "kimi_coding",
    );

    // The generic create main path handles kimi_coding with no category switch.
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://api.kimi.com/coding/v1",
        displayName: "My Kimi",
        templateId: "kimi_coding",
      }),
    ).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/v1",
      displayName: "My Kimi",
      id: "kimi_coding",
      providerKey: "kimi_coding",
      providerTemplateId: "kimi_coding",
      providerType: "api_key",
    });
  });

  it("keeps long-tail OpenAI-compatible list scoped to long-tail providers", () => {
    const templates = listOpenAICompatibleProviderTemplates();

    expect(templates.map((template) => template.id)).toEqual([
      "deepseek",
      "xai",
      "qwen",
      "qwen_token_plan",
      "moonshot",
      "minimax",
      "zai",
      "glm_coding",
      "command_code",
      "nous",
      "cline_pass",
      "byteplus_coding",
      "mistral",
      "groq",
      "cerebras",
      "fireworks",
      "nvidia",
      "xiaomi",
      "ollama_cloud",
      "opencode_go",
      "xiaomi_token_plan",
      "mistral_vibe",
    ]);
    for (const template of templates) {
      expect(template.endpoints).toEqual({
        chat_completions: chatEndpoint,
        models: modelsEndpoint,
        ...(template.id === "xai" || template.id === "qwen" || template.id === "minimax"
          ? { responses: responsesEndpoint }
          : {}),
        // command_code and opencode_go carry a second routable face (Anthropic
        // messages) that rides on the same base; the Console renders both chips.
        ...(template.id === "command_code" || template.id === "opencode_go"
          ? { messages: messagesEndpoint }
          : {}),
      });
      expect(template).not.toHaveProperty("capabilities");
    }
  });

  it("records provider-documented endpoint subsets for routed template providers", () => {
    expect(readTemplate("remote_api_key", "openrouter").endpoints).toEqual({
      chat_completions: chatEndpoint,
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
