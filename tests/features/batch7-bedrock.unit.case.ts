import { describe, expect, it } from "vitest";
import { providerRegistry } from "../../packages/config/src/provider-registry";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { buildChatCompletionsUrl } from "../../packages/provider/src/adapters/openai";
import {
  listPriceSyncSupportedProviderKeys,
  resolveProviderDescriptor,
} from "../../packages/provider/src/descriptor";
import {
  fetchProviderModelPrices,
  MODELS_DEV_PRICE_SOURCE_URL,
} from "../../packages/provider/src/price-source";
import { quotaProbes, resolveQuotaProbe } from "../../packages/provider/src/quota-probe";

// Batch 7 adds AWS Bedrock as a paste-key (ABSK Bearer) OpenAI chat_completions
// provider on the mantle OpenAI-compatible face. Field literals are transcribed
// from the local Batch 7 Bedrock plan so this test is an independent witness.
const remoteTemplateAuth = { header: "Authorization", scheme: "Bearer" };
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" };
const modelsEndpoint = { method: "GET", path: "models" };
const bedrockMantleBase = "https://bedrock-mantle.us-east-1.api.aws/v1";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("batch 7 bedrock provider", () => {
  it("registers bedrock as a priced OpenAI chat_completions api_key provider", () => {
    expect(providerRegistry.bedrock).toEqual({
      behavior: {
        priceSyncSupported: true,
        quotaSource: { reason: "requires_separate_credential", supported: false },
      },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: remoteTemplateAuth,
        // Default region us-east-1; base is user-editable (bedrock-runtime
        // regional hosts also work).
        baseUrl: bedrockMantleBase,
      },
      displayName: "AWS Bedrock",
      endpoints: { chat_completions: chatCompletionsEndpoint },
      modelListEndpoint: modelsEndpoint,
      providerKey: "bedrock",
      providerType: "api_key",
    });
    // Chat-only for this batch: no responses/messages faces.
    expect(providerRegistry.bedrock.endpoints.responses).toBeUndefined();
    expect(providerRegistry.bedrock.endpoints.messages).toBeUndefined();
  });

  it("routes chat_completions egress to base + /chat/completions", () => {
    expect(buildChatCompletionsUrl(bedrockMantleBase)).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions",
    );
  });

  it("keeps default connectivity and model-list styles", () => {
    const descriptor = resolveProviderDescriptor("bedrock");
    expect(descriptor.connectivityProbeStyle).toBeUndefined();
    expect(descriptor.modelListStyle).toBeUndefined();
    expect(providerRegistry.bedrock.behavior.metadataKey).toBeUndefined();
  });

  it("has no quota probe and appears in the API Keys group with a single chip", () => {
    expect(quotaProbes.bedrock).toBeUndefined();
    expect(resolveQuotaProbe("bedrock")).toBeNull();

    const apiKeysGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );
    expect(apiKeysGroup?.label).toBe("API Keys");
    const apiKeysIds = apiKeysGroup?.templates.map((template) => template.id) ?? [];
    expect(apiKeysIds).toContain("bedrock");
    expect(listOpenAICompatibleProviderTemplates().map((template) => template.id)).toContain(
      "bedrock",
    );
    expect(getOpenAICompatibleProviderTemplate("bedrock").providerKey).toBe("bedrock");

    const template = apiKeysGroup?.templates.find((entry) => entry.id === "bedrock");
    expect(Object.keys(template?.endpoints ?? {})).toEqual(["chat_completions", "models"]);
  });

  it("is on the price-sync allowlist and maps amazon-bedrock prices via alias", async () => {
    expect(listPriceSyncSupportedProviderKeys()).toContain("bedrock");

    // models.dev names the section "amazon-bedrock"; without the alias the
    // prices would be dropped despite bedrock being allowlisted (fireworks-ai
    // precedent).
    const priceFixture = {
      "amazon-bedrock": {
        models: {
          "global.anthropic.claude-opus-4-8": {
            cost: { input: 15, output: 75 },
            id: "global.anthropic.claude-opus-4-8",
          },
        },
      },
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === MODELS_DEV_PRICE_SOURCE_URL) {
        return jsonResponse(priceFixture);
      }
      return jsonResponse({});
    }) as typeof globalThis.fetch;

    const prices = await fetchProviderModelPrices({ fetch: fetchImpl });
    const byKey = new Set(prices.map((price) => price.providerKey));
    expect(byKey.has("bedrock")).toBe(true);
    expect(byKey.has("amazon-bedrock")).toBe(false);
    expect(byKey.has("amazon_bedrock")).toBe(false);
  });
});
