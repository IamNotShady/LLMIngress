import { describe, expect, it } from "vitest";
import {
  type ProviderQuotaSource,
  providerRegistry,
} from "../../packages/config/src/provider-registry";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { buildChatCompletionsUrl } from "../../packages/provider/src/adapters/openai";
import { resolveProviderDescriptor } from "../../packages/provider/src/descriptor";
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";
import { quotaProbes, resolveQuotaProbe } from "../../packages/provider/src/quota-probe";

const remoteTemplateAuth = { header: "Authorization", scheme: "Bearer" };
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" };
const modelsEndpoint = { method: "GET", path: "models" };

// Batch 4: seven pay-as-you-go inference clouds join as pure OpenAI
// chat_completions paste-key providers with Bearer egress. Except for base URL,
// displayName and providerKey they are field-for-field identical; the only
// behavior variation is mistral's quotaSource (requires_separate_credential —
// its Admin usage API needs a separate enterprise credential), while the other
// six are not_supported. Feature B opens six onto the price-sync allowlist
// (priceSyncSupported: true); ollama_cloud stays off (its catalog section
// carries no per-token cost).
type Batch4Provider = {
  baseUrl: string;
  displayName: string;
  priceSyncSupported: boolean;
  providerKey: keyof typeof providerRegistry;
  quotaSource: ProviderQuotaSource;
};

const notSupported: ProviderQuotaSource = { reason: "not_supported", supported: false };
const requiresSeparateCredential: ProviderQuotaSource = {
  reason: "requires_separate_credential",
  supported: false,
};

const batch4Providers: Batch4Provider[] = [
  {
    baseUrl: "https://api.groq.com/openai/v1",
    displayName: "Groq",
    priceSyncSupported: true,
    providerKey: "groq",
    quotaSource: notSupported,
  },
  {
    baseUrl: "https://api.cerebras.ai/v1",
    displayName: "Cerebras",
    priceSyncSupported: true,
    providerKey: "cerebras",
    quotaSource: notSupported,
  },
  {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    displayName: "Fireworks AI",
    priceSyncSupported: true,
    providerKey: "fireworks",
    quotaSource: notSupported,
  },
  {
    baseUrl: "https://api.mistral.ai/v1",
    displayName: "Mistral",
    priceSyncSupported: true,
    providerKey: "mistral",
    quotaSource: requiresSeparateCredential,
  },
  {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    displayName: "NVIDIA NIM",
    priceSyncSupported: true,
    providerKey: "nvidia",
    quotaSource: notSupported,
  },
  {
    baseUrl: "https://api.xiaomimimo.com/v1",
    displayName: "Xiaomi MiMo",
    priceSyncSupported: true,
    providerKey: "xiaomi",
    quotaSource: notSupported,
  },
  {
    baseUrl: "https://ollama.com/v1",
    displayName: "Ollama Cloud",
    priceSyncSupported: false,
    providerKey: "ollama_cloud",
    quotaSource: notSupported,
  },
];

describe("batch 4 inference cloud providers", () => {
  it("registers all seven as OpenAI chat_completions api_key providers field-for-field", () => {
    for (const provider of batch4Providers) {
      expect(providerRegistry[provider.providerKey], provider.providerKey).toEqual({
        behavior: {
          ...(provider.priceSyncSupported ? { priceSyncSupported: true } : {}),
          quotaSource: provider.quotaSource,
        },
        creation: {
          mode: "template",
          selectorGroup: "remote_api_key",
          auth: remoteTemplateAuth,
          baseUrl: provider.baseUrl,
        },
        displayName: provider.displayName,
        endpoints: { chat_completions: chatCompletionsEndpoint },
        modelListEndpoint: modelsEndpoint,
        providerKey: provider.providerKey,
        providerType: "api_key",
      });
      // chat-only, no responses/messages face, no metadataKey and no probe-style
      // overrides; priceSyncSupported is set for the six on the allowlist and
      // stays unset for ollama_cloud.
      const entry = providerRegistry[provider.providerKey];
      expect(entry.endpoints.responses, provider.providerKey).toBeUndefined();
      expect(entry.endpoints.messages, provider.providerKey).toBeUndefined();
      expect(entry.behavior.priceSyncSupported, provider.providerKey).toBe(
        provider.priceSyncSupported ? true : undefined,
      );
      expect(entry.behavior.metadataKey, provider.providerKey).toBeUndefined();
      expect(entry.behavior.connectivityProbeStyle, provider.providerKey).toBeUndefined();
      expect(entry.behavior.modelListStyle, provider.providerKey).toBeUndefined();
    }
  });

  it("routes chat_completions egress to base + /chat/completions via the real adapter builder", () => {
    for (const provider of batch4Providers) {
      const entry = providerRegistry[provider.providerKey];
      const baseUrl = entry.creation.mode === "template" ? (entry.creation.baseUrl ?? "") : "";
      expect(buildChatCompletionsUrl(baseUrl), provider.providerKey).toBe(
        `${provider.baseUrl}/chat/completions`,
      );
    }
  });

  it("has no quota probe and defaults connectivity + model discovery for every provider", () => {
    for (const provider of batch4Providers) {
      expect(quotaProbes[provider.providerKey], provider.providerKey).toBeUndefined();
      expect(resolveQuotaProbe(provider.providerKey), provider.providerKey).toBeNull();

      const descriptor = resolveProviderDescriptor(provider.providerKey);
      expect(descriptor.connectivityProbeStyle, provider.providerKey).toBeUndefined();
      expect(descriptor.modelListStyle, provider.providerKey).toBeUndefined();

      // Model discovery is the generic Bearer GET {base}/models.
      const modelList = buildProviderModelListRequest({
        apiKey: "sk-batch4-secret",
        baseUrl: provider.baseUrl,
        providerKey: provider.providerKey,
      });
      expect(modelList.url, provider.providerKey).toBe(`${provider.baseUrl}/models`);
      expect(modelList.init.headers, provider.providerKey).toEqual({
        authorization: "Bearer sk-batch4-secret",
      });
    }
  });

  it("lists all seven in the Console API Keys selector group with a single Chat Completions chip", () => {
    const openAiCompatibleIds = listOpenAICompatibleProviderTemplates().map(
      (template) => template.id,
    );
    const apiKeysGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );
    expect(apiKeysGroup?.label).toBe("API Keys");
    const apiKeysIds = apiKeysGroup?.templates.map((template) => template.id) ?? [];

    for (const provider of batch4Providers) {
      expect(openAiCompatibleIds, provider.providerKey).toContain(provider.providerKey);
      expect(apiKeysIds, provider.providerKey).toContain(provider.providerKey);

      const template = apiKeysGroup?.templates.find((entry) => entry.id === provider.providerKey);
      expect(template?.baseUrlMode, provider.providerKey).toBe("user_remote");
      expect(template?.providerType, provider.providerKey).toBe("api_key");
      expect(template?.fixedBaseUrl, provider.providerKey).toBe(provider.baseUrl);
      expect(Object.keys(template?.endpoints ?? {}), provider.providerKey).toEqual([
        "chat_completions",
        "models",
      ]);
      expect(
        getOpenAICompatibleProviderTemplate(provider.providerKey).providerKey,
        provider.providerKey,
      ).toBe(provider.providerKey);
    }
  });

  it("keeps ollama_cloud (remote api_key) independent from the local ollama provider", () => {
    // ollama_cloud is a distinct pay-as-you-go remote key at ollama.com, not the
    // local ollama daemon: different providerType, selectorGroup, base handling.
    expect(providerRegistry.ollama_cloud.providerType).toBe("api_key");
    expect(providerRegistry.ollama.providerType).toBe("local");
    expect(providerRegistry.ollama_cloud.creation.selectorGroup).toBe("remote_api_key");
    expect(providerRegistry.ollama.creation.selectorGroup).toBe("local");

    // The local provider has priceSyncSupported (its catalog is user-local); the
    // remote cloud provider does not (its section carries no per-token cost).
    expect(providerRegistry.ollama.behavior.priceSyncSupported).toBe(true);
    expect(providerRegistry.ollama_cloud.behavior.priceSyncSupported).toBeUndefined();
    expect(providerRegistry.ollama_cloud.behavior.local).toBeUndefined();

    // ollama_cloud fixes an editable remote base; local ollama uses a private
    // placeholder base and carries no quotaSource.
    const cloud = providerRegistry.ollama_cloud.creation;
    expect(cloud.mode === "template" ? cloud.baseUrl : null).toBe("https://ollama.com/v1");
    expect(providerRegistry.ollama.behavior.quotaSource).toBeUndefined();
  });
});
