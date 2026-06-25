import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";

describe("feat-062 provider template selector", () => {
  it("lists subscription, remote API-key, and local template groups with fixed capabilities", () => {
    const groups = listProviderTemplateSelectorGroups();
    const subscriptionGroup = groups.find((group) => group.id === "subscription");
    const remoteGroup = groups.find((group) => group.id === "remote_api_key");
    const localGroup = groups.find((group) => group.id === "local");

    expect(groups.map((group) => group.id)).toEqual(["subscription", "remote_api_key", "local"]);
    expect(subscriptionGroup).toMatchObject({
      id: "subscription",
      label: "Subscription",
      templates: [
        {
          baseUrlMode: "fixed_remote",
          capabilities: ["responses"],
          displayName: "OpenAI Codex",
          fixedBaseUrl: "https://chatgpt.com/backend-api",
          id: "openai_codex",
          providerKey: "openai_codex",
          providerType: "subscription",
        },
        {
          baseUrlMode: "fixed_remote",
          capabilities: ["messages"],
          displayName: "Claude Code",
          fixedBaseUrl: "https://api.anthropic.com",
          id: "claude_code",
          providerKey: "claude_code",
          providerType: "subscription",
        },
      ],
    });
    expect(remoteGroup).toMatchObject({
      id: "remote_api_key",
      label: "API Keys",
    });
    expect(remoteGroup?.templates).toHaveLength(8);
    expect(remoteGroup?.templates).toEqual(
      expect.arrayContaining([
        {
          auth: {
            header: "Authorization",
            scheme: "Bearer",
          },
          baseUrlMode: "fixed_remote",
          capabilities: ["chat_completions", "streaming", "tools"],
          displayName: "DeepSeek",
          fixedBaseUrl: "https://api.deepseek.com",
          id: "deepseek",
          providerKey: "deepseek",
          providerType: "api_key",
        },
      ]),
    );
    expect(localGroup).toEqual({
      id: "local",
      label: "Local",
      templates: expect.arrayContaining([
        expect.objectContaining({
          baseUrlMode: "user_local_private",
          capabilities: ["chat_completions", "streaming", "tools"],
          chatPath: "/chat/completions",
          displayName: "Ollama",
          id: "ollama",
          modelListPath: "/models",
          providerKey: "ollama",
          providerType: "local",
        }),
      ]),
    });
  });

  it("accepts only whitelisted selector templates and rejects arbitrary endpoints", () => {
    expect(normalizeProviderTemplateFormInput({ templateId: "deepseek" })).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      providerKey: "deepseek",
      providerType: "api_key",
    });

    expect(normalizeProviderTemplateFormInput({ templateId: "openai_codex" })).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      providerKey: "openai_codex",
      providerType: "subscription",
    });
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://chatgpt.com/backend-api",
        templateId: "openai_codex",
      }),
    ).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      providerKey: "openai_codex",
      providerType: "subscription",
    });

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://127.0.0.1:11434/v1",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
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
      normalizeProviderTemplateFormInput({
        baseUrl: "https://arbitrary.example/subscription",
        templateId: "openai_codex",
      }),
    ).toThrow(/custom subscription endpoints are not allowed/i);

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
