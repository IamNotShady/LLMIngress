import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";

describe("feat-062 provider template selector", () => {
  it("lists remote API-key and local template groups with fixed capabilities", () => {
    expect(listProviderTemplateSelectorGroups()).toEqual([
      {
        id: "remote_api_key",
        label: "Remote API-key templates",
        templates: [
          {
            baseUrlMode: "fixed_remote",
            capabilities: ["chat_completions", "streaming", "tools"],
            displayName: "DeepSeek",
            fixedBaseUrl: "https://api.deepseek.com/v1",
            id: "deepseek",
            providerKey: "deepseek",
            providerType: "api_key",
          },
        ],
      },
      {
        id: "local",
        label: "Local templates",
        templates: [
          {
            baseUrlMode: "user_local_private",
            capabilities: ["chat_completions"],
            chatPath: "/api/chat",
            displayName: "Ollama",
            id: "ollama",
            modelListPath: "/api/tags",
            providerKey: "ollama",
            providerType: "local",
          },
        ],
      },
    ]);
  });

  it("accepts only whitelisted selector templates and rejects arbitrary endpoints", () => {
    expect(normalizeProviderTemplateFormInput({ templateId: "deepseek" })).toMatchObject({
      baseUrl: "https://api.deepseek.com/v1",
      providerKey: "deepseek",
      providerType: "api_key",
    });

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://127.0.0.1:11434",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:11434",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });

    expect(() =>
      normalizeProviderTemplateFormInput({
        baseUrl: "https://arbitrary.example/v1",
        templateId: "deepseek",
      }),
    ).toThrow(/custom OpenAI-compatible endpoints are not allowed/i);

    expect(() =>
      normalizeProviderFormInput({
        baseUrl: "https://arbitrary.example/v1",
        displayName: "Custom",
        providerKey: "custom",
        providerType: "api_key",
      }),
    ).toThrow(/custom OpenAI-compatible endpoints are not allowed/i);
  });
});
