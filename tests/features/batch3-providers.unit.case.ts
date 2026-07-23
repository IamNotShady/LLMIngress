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
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";
import { quotaProbes, resolveQuotaProbe } from "../../packages/provider/src/quota-probe";

const remoteTemplateAuth = { header: "Authorization", scheme: "Bearer" };
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" };
const messagesEndpoint = { method: "POST", path: "messages" };
const modelsEndpoint = { method: "GET", path: "models" };

function registryBaseUrl(providerKey: keyof typeof providerRegistry): string {
  const entry = providerRegistry[providerKey];
  return entry.creation.mode === "template" ? (entry.creation.baseUrl ?? "") : "";
}

// Batch 3 Feature A: Command Code (command_code) + NousResearch (nous). Both are
// paste-key api_key providers in the Console "API Keys" template group.
// command_code is the first api_key provider with dual routable endpoints —
// chat_completions egress with Bearer plus messages egress where the upstream
// authenticates with x-api-key. nous is a plain chat_completions Bearer provider.

describe("batch 3 command code and nous providers", () => {
  it("registers command_code as a dual-endpoint api_key provider", () => {
    expect(providerRegistry.command_code).toEqual({
      behavior: { quotaSource: { reason: "not_supported", supported: false } },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: remoteTemplateAuth,
        baseUrl: "https://api.commandcode.ai/provider/v1",
      },
      displayName: "Command Code",
      endpoints: {
        chat_completions: chatCompletionsEndpoint,
        messages: messagesEndpoint,
      },
      modelListEndpoint: modelsEndpoint,
      providerKey: "command_code",
      providerType: "api_key",
    });
    // Both faces share one base; there is no responses endpoint and no quota
    // probe (Pay-as-you-go / plan API without a quota endpoint).
    expect(providerRegistry.command_code.endpoints.responses).toBeUndefined();
    expect(providerRegistry.command_code.behavior.priceSyncSupported).toBeUndefined();
    expect(providerRegistry.command_code.behavior.metadataKey).toBeUndefined();
  });

  it("registers nous as an OpenAI chat_completions api_key provider", () => {
    expect(providerRegistry.nous).toEqual({
      behavior: { quotaSource: { reason: "not_supported", supported: false } },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: remoteTemplateAuth,
        baseUrl: "https://inference-api.nousresearch.com/v1",
      },
      displayName: "NousResearch",
      endpoints: { chat_completions: chatCompletionsEndpoint },
      modelListEndpoint: modelsEndpoint,
      providerKey: "nous",
      providerType: "api_key",
    });
    // chat_completions only — no messages face, no responses, no price sync.
    expect(providerRegistry.nous.endpoints.messages).toBeUndefined();
    expect(providerRegistry.nous.endpoints.responses).toBeUndefined();
    expect(providerRegistry.nous.behavior.priceSyncSupported).toBeUndefined();
    expect(providerRegistry.nous.behavior.metadataKey).toBeUndefined();
  });

  it("routes egress URLs for both faces via the real adapter builders", () => {
    // chat_completions egress (adapters/openai.ts) for both providers.
    expect(buildChatCompletionsUrl(registryBaseUrl("command_code"))).toBe(
      "https://api.commandcode.ai/provider/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl(registryBaseUrl("nous"))).toBe(
      "https://inference-api.nousresearch.com/v1/chat/completions",
    );
    // command_code messages egress (adapters/anthropic.ts) shares the same base;
    // /provider/v1 lives in the base URL and is preserved.
    expect(buildAnthropicMessagesUrl(registryBaseUrl("command_code"))).toBe(
      "https://api.commandcode.ai/provider/v1/messages",
    );
  });

  it("keeps default connectivity and model-list styles for command_code", () => {
    const descriptor = resolveProviderDescriptor("command_code");
    expect(descriptor.connectivityProbeStyle).toBeUndefined();
    expect(descriptor.modelListStyle).toBeUndefined();

    // Model discovery is the generic Bearer GET {base}/models — the chat face is
    // Bearer, distinct from the x-api-key that the messages egress hardcodes.
    const modelList = buildProviderModelListRequest({
      apiKey: "sk-command-secret",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      providerKey: "command_code",
    });
    expect(modelList.url).toBe("https://api.commandcode.ai/provider/v1/models");
    expect(modelList.init.headers).toEqual({ authorization: "Bearer sk-command-secret" });
    expect(modelList.init.headers).not.toHaveProperty("x-api-key");
  });

  it("has no quota probes and appears in the API Keys group with the right chips", () => {
    expect(quotaProbes.command_code).toBeUndefined();
    expect(quotaProbes.nous).toBeUndefined();
    expect(resolveQuotaProbe("command_code")).toBeNull();
    expect(resolveQuotaProbe("nous")).toBeNull();

    const openAiCompatibleIds = listOpenAICompatibleProviderTemplates().map(
      (template) => template.id,
    );
    expect(openAiCompatibleIds).toContain("command_code");
    expect(openAiCompatibleIds).toContain("nous");

    const apiKeysGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );
    expect(apiKeysGroup?.label).toBe("API Keys");
    const apiKeysIds = apiKeysGroup?.templates.map((template) => template.id) ?? [];
    expect(apiKeysIds).toContain("command_code");
    expect(apiKeysIds).toContain("nous");

    for (const id of ["command_code", "nous"] as const) {
      const template = apiKeysGroup?.templates.find((entry) => entry.id === id);
      expect(template?.baseUrlMode).toBe("user_remote");
      expect(template?.providerType).toBe("api_key");
      expect(getOpenAICompatibleProviderTemplate(id).providerKey).toBe(id);
    }

    // command_code carries both endpoint keys (Console renders Chat Completions
    // + Messages chips from this data), while nous is chat-only.
    const commandTemplate = apiKeysGroup?.templates.find((entry) => entry.id === "command_code");
    expect(Object.keys(commandTemplate?.endpoints ?? {})).toEqual(
      expect.arrayContaining(["chat_completions", "messages"]),
    );
    const nousTemplate = apiKeysGroup?.templates.find((entry) => entry.id === "nous");
    expect(Object.keys(nousTemplate?.endpoints ?? {})).toContain("chat_completions");
    expect(Object.keys(nousTemplate?.endpoints ?? {})).not.toContain("messages");
  });
});
