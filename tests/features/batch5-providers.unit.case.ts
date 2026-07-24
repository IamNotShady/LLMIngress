import { describe, expect, it } from "vitest";
import { providerRegistry } from "../../packages/config/src/provider-registry";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { buildAnthropicMessagesUrl } from "../../packages/provider/src/adapters/anthropic";
import { buildChatCompletionsUrl } from "../../packages/provider/src/adapters/openai";
import { resolveProviderDescriptor } from "../../packages/provider/src/descriptor";
import { quotaProbes, resolveQuotaProbe } from "../../packages/provider/src/quota-probe";

// Batch 5 completes the token-paste alignment track with three subscription-plan
// providers that connect by pasting a token, so all three are api_key entries in
// the remote_api_key selector group. Field literals are transcribed from the
// donor plan so this test is an independent witness of the registry data.
const remoteTemplateAuth = { header: "Authorization", scheme: "Bearer" };
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" };
const messagesEndpoint = { method: "POST", path: "messages" };
const modelsEndpoint = { method: "GET", path: "models" };

describe("batch 5 token plan providers", () => {
  it("registers opencode_go as a dual-endpoint api_key provider", () => {
    expect(providerRegistry.opencode_go).toEqual({
      behavior: { quotaSource: { reason: "not_supported", supported: false } },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: remoteTemplateAuth,
        baseUrl: "https://opencode.ai/zen/go/v1",
      },
      displayName: "OpenCode Go",
      // Dual routable faces from one base: chat_completions carries the Bearer
      // credential; messages authenticates with a bare x-api-key (hardcoded by
      // the anthropic adapter), like command_code.
      endpoints: {
        chat_completions: chatCompletionsEndpoint,
        messages: messagesEndpoint,
      },
      modelListEndpoint: modelsEndpoint,
      providerKey: "opencode_go",
      providerType: "api_key",
    });
  });

  it("registers xiaomi_token_plan and mistral_vibe as chat-only api_key providers", () => {
    expect(providerRegistry.xiaomi_token_plan).toEqual({
      behavior: { quotaSource: { reason: "not_supported", supported: false } },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: remoteTemplateAuth,
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      },
      displayName: "Xiaomi MiMo Token Plan",
      endpoints: { chat_completions: chatCompletionsEndpoint },
      modelListEndpoint: modelsEndpoint,
      providerKey: "xiaomi_token_plan",
      providerType: "api_key",
    });
    expect(providerRegistry.mistral_vibe).toEqual({
      // Vibe usage lives behind a separate enterprise Admin credential, so quota
      // is requires_separate_credential (same judgment as the standard mistral).
      behavior: {
        quotaSource: { reason: "requires_separate_credential", supported: false },
      },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: remoteTemplateAuth,
        baseUrl: "https://api.mistral.ai/v1",
      },
      displayName: "Mistral Vibe",
      endpoints: { chat_completions: chatCompletionsEndpoint },
      modelListEndpoint: modelsEndpoint,
      providerKey: "mistral_vibe",
      providerType: "api_key",
    });
  });

  it("routes egress URLs through the real adapter builders", () => {
    expect(buildChatCompletionsUrl("https://opencode.ai/zen/go/v1")).toBe(
      "https://opencode.ai/zen/go/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl("https://token-plan-sgp.xiaomimimo.com/v1")).toBe(
      "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl("https://api.mistral.ai/v1")).toBe(
      "https://api.mistral.ai/v1/chat/completions",
    );
    // opencode_go's second face routes to base + /messages.
    expect(buildAnthropicMessagesUrl("https://opencode.ai/zen/go/v1")).toBe(
      "https://opencode.ai/zen/go/v1/messages",
    );
  });

  it("keeps default connectivity and model-list styles for all three", () => {
    for (const key of ["opencode_go", "xiaomi_token_plan", "mistral_vibe"] as const) {
      const descriptor = resolveProviderDescriptor(key);
      expect(descriptor.connectivityProbeStyle, key).toBeUndefined();
      expect(descriptor.modelListStyle, key).toBeUndefined();
      expect(providerRegistry[key].behavior.metadataKey, key).toBeUndefined();
      expect(providerRegistry[key].behavior.priceSyncSupported, key).toBeUndefined();
    }
    // opencode_go carries a messages face, yet it stays on the default Bearer
    // connectivity/model-discovery styles (the messages face does not force the
    // anthropic style, unlike kimi_coding).
    expect(providerRegistry.opencode_go.endpoints.messages).toEqual(messagesEndpoint);
    expect(resolveProviderDescriptor("opencode_go").connectivityProbeStyle).toBeUndefined();
    expect(resolveProviderDescriptor("opencode_go").modelListStyle).toBeUndefined();
  });

  it("has no quota probes and appears in the API Keys selector group", () => {
    const apiKeysGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );
    expect(apiKeysGroup?.label).toBe("API Keys");
    const apiKeysIds = apiKeysGroup?.templates.map((template) => template.id) ?? [];
    const openAiCompatibleIds = listOpenAICompatibleProviderTemplates().map(
      (template) => template.id,
    );

    for (const key of ["opencode_go", "xiaomi_token_plan", "mistral_vibe"] as const) {
      expect(quotaProbes[key], key).toBeUndefined();
      expect(resolveQuotaProbe(key), key).toBeNull();
      expect(apiKeysIds, key).toContain(key);
      expect(openAiCompatibleIds, key).toContain(key);
      expect(getOpenAICompatibleProviderTemplate(key).providerKey, key).toBe(key);
    }

    // Data side of the endpoint chips: opencode_go exposes two routable faces
    // (chat_completions + messages), the other two a single chat face.
    const opencodeGo = apiKeysGroup?.templates.find((template) => template.id === "opencode_go");
    expect(Object.keys(opencodeGo?.endpoints ?? {})).toEqual([
      "chat_completions",
      "messages",
      "models",
    ]);
    for (const key of ["xiaomi_token_plan", "mistral_vibe"] as const) {
      const template = apiKeysGroup?.templates.find((entry) => entry.id === key);
      expect(Object.keys(template?.endpoints ?? {}), key).toEqual(["chat_completions", "models"]);
    }
  });

  it("keeps mistral_vibe distinct from mistral while sharing the base", () => {
    // Two independent registry keys pointing at the same upstream base; the key
    // (and its pasted credential) differs, the base URL and quota judgment match.
    // This pins the "same base, distinct key" contract for the standard/vibe pair.
    expect(providerRegistry.mistral_vibe.providerKey).toBe("mistral_vibe");
    expect(providerRegistry.mistral.providerKey).toBe("mistral");
    expect(providerRegistry.mistral_vibe.providerKey).not.toBe(providerRegistry.mistral.providerKey);

    const vibeBase =
      providerRegistry.mistral_vibe.creation.mode === "template"
        ? providerRegistry.mistral_vibe.creation.baseUrl
        : null;
    const mistralBase =
      providerRegistry.mistral.creation.mode === "template"
        ? providerRegistry.mistral.creation.baseUrl
        : null;
    expect(vibeBase).toBe("https://api.mistral.ai/v1");
    expect(vibeBase).toBe(mistralBase);

    expect(providerRegistry.mistral_vibe.behavior.quotaSource).toEqual(
      providerRegistry.mistral.behavior.quotaSource,
    );
    expect(providerRegistry.mistral_vibe.behavior.quotaSource).toEqual({
      reason: "requires_separate_credential",
      supported: false,
    });
    // mistral_vibe stays off the price-sync allowlist (a subscription plan has no
    // per-token list price), unlike the standard mistral which is on it.
    expect(providerRegistry.mistral_vibe.behavior.priceSyncSupported).toBeUndefined();
    expect(providerRegistry.mistral.behavior.priceSyncSupported).toBe(true);
  });
});
