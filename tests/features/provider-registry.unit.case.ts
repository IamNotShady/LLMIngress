import { describe, expect, it } from "vitest";
import {
  defaultEndpointPathByProtocol,
  defaultModelListPath,
  listDirectCreateEntries,
  listPriceSyncSupportedProviderKeys,
  listProviderRouteEndpointProtocols,
  listProviderTemplateEntries,
  listSubscriptionProviderKeys,
  type ProviderRegistryEntry,
  providerRegistry,
  providerSupportsRouteEndpointProtocol,
  resolveProviderRegistryEntry,
  routeEndpointProtocols,
  subscriptionProviderKeys,
} from "../../packages/config/src/provider-registry";

// Endpoint literals copied from the donor files so the test is an independent
// witness of the migrated data, not a mirror of the implementation.
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" } as const;
const messagesEndpoint = { method: "POST", path: "messages" } as const;
const responsesEndpoint = { method: "POST", path: "responses" } as const;
const modelsEndpoint = { method: "GET", path: "models" } as const;
const remoteTemplateAuth = { header: "Authorization", scheme: "Bearer" } as const;

// Full expected registry, transcribed field-by-field from:
//   packages/provider/src/descriptor.ts (behavior)
//   packages/db/src/console-provider-templates.ts (creation/endpoints/modelList)
//   apps/console/src/app/_modules/providers-section.tsx (direct creation)
//   packages/db/src/console-route-policies.ts (direct endpoints)
//   packages/provider/src/oauth.ts (oauth)
const expectedRegistry: Record<string, ProviderRegistryEntry> = {
  anthropic: {
    behavior: {
      connectivityProbeStyle: "anthropic",
      fixedApiKeyBaseUrl: "https://api.anthropic.com/v1",
      modelListStyle: "anthropic",
      priceSyncSupported: true,
    },
    creation: {
      mode: "direct",
      selectorGroup: "remote_api_key",
      fixedBaseUrl: "https://api.anthropic.com/v1",
    },
    displayName: "Anthropic",
    endpoints: { messages: messagesEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "anthropic",
    providerType: "api_key",
  },
  claude_code: {
    behavior: {
      connectivityProbeStyle: "claude_code",
      metadataKey: "anthropic",
      modelListStyle: "claude_code",
      oauthStateFromCodeVerifier: true,
      subscription: true,
      subscriptionAdapter: "claude_code",
    },
    creation: {
      mode: "template",
      selectorGroup: "subscription",
      baseUrl: "https://api.anthropic.com",
    },
    displayName: "Claude Code",
    endpoints: { messages: { method: "POST", path: "v1/messages" } },
    modelListEndpoint: { method: "GET", path: "v1/models" },
    oauth: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      defaultParams: { code: "true", prompt: "login" },
      redirectUri: "https://console.anthropic.com/oauth/code/callback",
      scope: "org:create_api_key user:profile user:inference",
      tokenEncoding: "json",
      tokenHeaders: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "anthropic",
      },
      tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    },
    providerKey: "claude_code",
    providerType: "subscription",
  },
  deepseek: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.deepseek.com",
    },
    displayName: "DeepSeek",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "deepseek",
    providerType: "api_key",
  },
  google: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    displayName: "Google Gemini",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "google",
    providerType: "api_key",
  },
  llama_cpp: {
    behavior: { local: true, priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "local",
      baseUrlPlaceholder: "http://127.0.0.1:8080/v1",
    },
    displayName: "llama.cpp",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "llama_cpp",
    providerType: "local",
  },
  lmstudio: {
    behavior: { local: true, modelListStyle: "lmstudio", priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "local",
      baseUrlPlaceholder: "http://127.0.0.1:1234/v1",
    },
    displayName: "LM Studio",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "lmstudio",
    providerType: "local",
  },
  minimax: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.minimax.io/v1",
    },
    displayName: "MiniMax",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "minimax",
    providerType: "api_key",
  },
  moonshot: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.moonshot.ai/v1",
    },
    displayName: "Moonshot/Kimi",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "moonshot",
    providerType: "api_key",
  },
  ollama: {
    behavior: { local: true, priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "local",
      baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
    },
    displayName: "Ollama",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "ollama",
    providerType: "local",
  },
  openai: {
    behavior: {
      fixedApiKeyBaseUrl: "https://api.openai.com/v1",
      priceSyncSupported: true,
      reasoningAwareProbe: true,
    },
    creation: {
      mode: "direct",
      selectorGroup: "remote_api_key",
      fixedBaseUrl: "https://api.openai.com/v1",
    },
    displayName: "OpenAI",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "openai",
    providerType: "api_key",
  },
  openai_codex: {
    behavior: {
      connectivityProbeStyle: "codex",
      metadataKey: "openai",
      modelListStyle: "codex",
      subscription: true,
      subscriptionAdapter: "codex",
    },
    creation: {
      mode: "template",
      selectorGroup: "subscription",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    displayName: "OpenAI Codex",
    endpoints: { responses: { method: "POST", path: "codex/responses" } },
    modelListEndpoint: { method: "GET", path: "codex/models" },
    oauth: {
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      defaultParams: {
        codex_cli_simplified_flow: "true",
        id_token_add_organizations: "true",
        originator: "codex_cli_rs",
        prompt: "login",
      },
      redirectUri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      revokeUrl: "https://auth.openai.com/oauth/revoke",
      tokenEncoding: "form",
      tokenHeaders: { accept: "application/json" },
      tokenUrl: "https://auth.openai.com/oauth/token",
    },
    providerKey: "openai_codex",
    providerType: "subscription",
  },
  openrouter: {
    behavior: {
      fixedApiKeyBaseUrl: "https://openrouter.ai/api/v1",
      modelListStyle: "openrouter",
      openRouterAttribution: true,
      priceSyncSupported: true,
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://openrouter.ai/api/v1",
    },
    displayName: "OpenRouter",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "openrouter",
    providerType: "api_key",
  },
  qwen: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    },
    displayName: "Qwen",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "qwen",
    providerType: "api_key",
  },
  xai: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.x.ai/v1",
    },
    displayName: "xAI",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "xai",
    providerType: "api_key",
  },
  zai: {
    behavior: { priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.z.ai/api/paas/v4",
    },
    displayName: "Z.ai",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "zai",
    providerType: "api_key",
  },
};

describe("provider metadata registry", () => {
  it("carries every provider entry field-for-field from the donor sources", () => {
    expect(providerRegistry).toEqual(expectedRegistry);
    expect(Object.keys(providerRegistry)).toHaveLength(15);
  });

  it("keeps the models catalog out of the routable endpoint face", () => {
    for (const entry of Object.values(providerRegistry)) {
      for (const protocol of Object.keys(entry.endpoints)) {
        expect(routeEndpointProtocols).toContain(protocol);
        expect(protocol).not.toBe("models");
      }
    }
    // The models catalog lives on modelListEndpoint, never in endpoints.
    expect(providerRegistry.openai_codex.modelListEndpoint).toEqual({
      method: "GET",
      path: "codex/models",
    });
    expect(providerRegistry.claude_code.modelListEndpoint).toEqual({
      method: "GET",
      path: "v1/models",
    });
  });

  it("resolves entries case-insensitively and returns null for unknown keys", () => {
    expect(resolveProviderRegistryEntry("OpenRouter")).toBe(providerRegistry.openrouter);
    expect(resolveProviderRegistryEntry("  claude_code  ")).toBe(providerRegistry.claude_code);
    expect(resolveProviderRegistryEntry("my-vllm")).toBeNull();
    expect(resolveProviderRegistryEntry(null)).toBeNull();
    expect(resolveProviderRegistryEntry(undefined)).toBeNull();
  });

  it("applies a permissive protocol policy for unknown providers", () => {
    expect(listProviderRouteEndpointProtocols("my-vllm")).toEqual([
      "chat_completions",
      "responses",
      "messages",
    ]);
    for (const protocol of routeEndpointProtocols) {
      expect(providerSupportsRouteEndpointProtocol("my-vllm", protocol)).toBe(true);
    }
  });

  it("derives route endpoint protocols from each entry's endpoint face", () => {
    expect(listProviderRouteEndpointProtocols("openai")).toEqual(["chat_completions", "responses"]);
    expect(listProviderRouteEndpointProtocols("anthropic")).toEqual(["messages"]);
    expect(listProviderRouteEndpointProtocols("openrouter")).toEqual([
      "chat_completions",
      "messages",
      "responses",
    ]);
    expect(listProviderRouteEndpointProtocols("deepseek")).toEqual(["chat_completions"]);
    expect(listProviderRouteEndpointProtocols("openai_codex")).toEqual(["responses"]);
    expect(listProviderRouteEndpointProtocols("claude_code")).toEqual(["messages"]);

    expect(providerSupportsRouteEndpointProtocol("deepseek", "messages")).toBe(false);
    expect(providerSupportsRouteEndpointProtocol("openai", "responses")).toBe(true);
  });

  it("lists the subscription providers", () => {
    expect(listSubscriptionProviderKeys()).toEqual(["claude_code", "openai_codex"]);
  });

  it("pins the SubscriptionProviderKey type carrier to the registry's subscription flags", () => {
    // subscriptionProviderKeys is the runtime carrier of the type; if a
    // subscription provider is added to (or removed from) the registry without
    // updating the carrier, these drift apart and this test goes red.
    expect([...subscriptionProviderKeys]).toEqual(listSubscriptionProviderKeys());
  });

  it("lists the price-sync supported providers (everything except subscriptions)", () => {
    expect(listPriceSyncSupportedProviderKeys().sort()).toEqual([
      "anthropic",
      "deepseek",
      "google",
      "llama_cpp",
      "lmstudio",
      "minimax",
      "moonshot",
      "ollama",
      "openai",
      "openrouter",
      "qwen",
      "xai",
      "zai",
    ]);
  });

  it("exposes the direct-create entries in Console order", () => {
    expect(listDirectCreateEntries().map((entry) => entry.providerKey)).toEqual([
      "openai",
      "anthropic",
    ]);
    for (const entry of listDirectCreateEntries()) {
      expect(entry.creation.mode).toBe("direct");
    }
  });

  it("exposes the template entries in selector order and excludes direct entries", () => {
    expect(listProviderTemplateEntries().map((entry) => entry.providerKey)).toEqual([
      "openai_codex",
      "claude_code",
      "google",
      "openrouter",
      "deepseek",
      "xai",
      "qwen",
      "moonshot",
      "minimax",
      "zai",
      "ollama",
      "lmstudio",
      "llama_cpp",
    ]);
    for (const entry of listProviderTemplateEntries()) {
      expect(entry.creation.mode).toBe("template");
    }
  });

  it("publishes default endpoint paths per protocol", () => {
    expect(defaultEndpointPathByProtocol).toEqual({
      chat_completions: "chat/completions",
      messages: "messages",
      responses: "responses",
    });
    expect(defaultModelListPath).toBe("models");
  });
});
