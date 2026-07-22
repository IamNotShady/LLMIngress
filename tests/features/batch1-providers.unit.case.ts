import { describe, expect, it } from "vitest";
import { providerRegistry } from "../../packages/config/src/provider-registry";
import {
  getAnthropicCompatibleProviderTemplate,
  getOpenAICompatibleProviderTemplate,
  isAnthropicCompatibleProviderTemplateId,
  listAnthropicCompatibleProviderTemplates,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { buildAnthropicMessagesUrl } from "../../packages/provider/src/adapters/anthropic";
import { buildChatCompletionsUrl } from "../../packages/provider/src/adapters/openai";
import { buildProviderConnectivityRequest } from "../../packages/provider/src/connectivity";
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";
import { quotaProbes, resolveQuotaProbe } from "../../packages/provider/src/quota-probe";

// Batch 1 Feature A: GLM Coding Plan (glm_coding) + Qwen Token Plan
// (qwen_token_plan). Both are OpenAI chat_completions api_key providers that
// join the Console "API Keys" template group via the paste-key flow.

describe("batch 1 glm/qwen providers", () => {
  it("registers glm_coding as an OpenAI chat_completions api_key provider", () => {
    expect(providerRegistry.glm_coding).toEqual({
      behavior: {
        metadataKey: "zai",
        quotaSource: { supported: true },
      },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: { header: "Authorization", scheme: "Bearer" },
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      },
      displayName: "GLM Coding Plan",
      endpoints: { chat_completions: { method: "POST", path: "chat/completions" } },
      modelListEndpoint: { method: "GET", path: "models" },
      providerKey: "glm_coding",
      providerType: "api_key",
    });
    // The version segment differs from Z.ai's /api/paas/v4, and no responses
    // endpoint exists (Batch 1 non-target).
    expect(providerRegistry.glm_coding.endpoints.responses).toBeUndefined();
  });

  it("registers qwen_token_plan as a chat_completions-only api_key provider with quota not supported", () => {
    expect(providerRegistry.qwen_token_plan).toEqual({
      behavior: {
        metadataKey: "qwen",
        quotaSource: { reason: "not_supported", supported: false },
      },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: { header: "Authorization", scheme: "Bearer" },
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      },
      displayName: "Qwen Token Plan",
      endpoints: { chat_completions: { method: "POST", path: "chat/completions" } },
      modelListEndpoint: { method: "GET", path: "models" },
      providerKey: "qwen_token_plan",
      providerType: "api_key",
    });
    // §2.3: responses is a Batch 1 non-target and must not be added.
    expect(providerRegistry.qwen_token_plan.endpoints.responses).toBeUndefined();
  });

  it("routes chat_completions egress to base + /chat/completions for both providers", () => {
    // Exercises the real adapter URL builder (adapters/openai.ts).
    for (const [key, expected] of [
      ["glm_coding", "https://api.z.ai/api/coding/paas/v4/chat/completions"],
      [
        "qwen_token_plan",
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      ],
    ] as const) {
      const entry = providerRegistry[key];
      const baseUrl = entry.creation.mode === "template" ? (entry.creation.baseUrl ?? "") : "";
      expect(buildChatCompletionsUrl(baseUrl)).toBe(expected);
    }
  });

  it("gives glm_coding a supported quota probe reusing the zai origin probe and none to qwen_token_plan", () => {
    // glm_coding reuses the exact zai probe function; its api.z.ai origin makes
    // the probe URL identical to zai's.
    expect(quotaProbes.glm_coding).toBe(quotaProbes.zai);
    expect(resolveQuotaProbe("glm_coding")).toBe(quotaProbes.zai);

    // qwen_token_plan is not_supported and carries no probe function.
    expect(quotaProbes.qwen_token_plan).toBeUndefined();
    expect(resolveQuotaProbe("qwen_token_plan")).toBeNull();
  });

  it("exposes both providers as OpenAI-compatible templates in the API Keys group", () => {
    const openAiCompatibleIds = listOpenAICompatibleProviderTemplates().map(
      (template) => template.id,
    );
    expect(openAiCompatibleIds).toContain("glm_coding");
    expect(openAiCompatibleIds).toContain("qwen_token_plan");

    const apiKeysGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );
    expect(apiKeysGroup?.label).toBe("API Keys");
    const apiKeysIds = apiKeysGroup?.templates.map((template) => template.id) ?? [];
    expect(apiKeysIds).toContain("glm_coding");
    expect(apiKeysIds).toContain("qwen_token_plan");

    // The paste-key flow uses an editable remote base URL (never local-private),
    // and the whitelisted getter accepts both ids.
    for (const id of ["glm_coding", "qwen_token_plan"] as const) {
      const template = apiKeysGroup?.templates.find((entry) => entry.id === id);
      expect(template?.baseUrlMode).toBe("user_remote");
      expect(template?.providerType).toBe("api_key");
      expect(getOpenAICompatibleProviderTemplate(id).providerKey).toBe(id);
    }
  });
});

// Batch 1 Feature B: Kimi Coding Plan (kimi_coding). First Anthropic-protocol
// non-official-base provider — messages + x-api-key egress, a new W1
// anthropic-compatible template category, and a Bearer quota probe.

describe("batch 1 kimi coding provider", () => {
  it("registers kimi_coding as an Anthropic messages api_key provider with x-api-key auth", () => {
    expect(providerRegistry.kimi_coding).toEqual({
      behavior: {
        connectivityProbeStyle: "anthropic",
        metadataKey: "moonshot",
        modelListStyle: "anthropic",
        quotaSource: { supported: true },
      },
      creation: {
        mode: "template",
        selectorGroup: "remote_api_key",
        auth: { header: "x-api-key", scheme: "" },
        baseUrl: "https://api.kimi.com/coding/v1",
      },
      displayName: "Kimi Coding Plan",
      endpoints: { messages: { method: "POST", path: "messages" } },
      modelListEndpoint: { method: "GET", path: "models" },
      providerKey: "kimi_coding",
      providerType: "api_key",
    });
    // /v1 lives in the base URL; the endpoint path is the shared "messages"
    // constant, never "v1/messages". No chat_completions face.
    expect(providerRegistry.kimi_coding.endpoints.messages?.path).toBe("messages");
    expect(providerRegistry.kimi_coding.endpoints.chat_completions).toBeUndefined();
  });

  it("resolves the messages egress URL to base + /messages (no /v1 loss)", () => {
    const baseUrl =
      providerRegistry.kimi_coding.creation.mode === "template"
        ? (providerRegistry.kimi_coding.creation.baseUrl ?? "")
        : "";
    expect(buildAnthropicMessagesUrl(baseUrl)).toBe("https://api.kimi.com/coding/v1/messages");
  });

  it("drives model-list and connectivity through the anthropic style end to end", () => {
    // Composition guard: the registry style fields dispatch the shared
    // builders into the anthropic shape (x-api-key), not the Bearer default.
    const modelList = buildProviderModelListRequest({
      apiKey: "sk-kimi-secret",
      baseUrl: "https://api.kimi.com/coding/v1",
      providerKey: "kimi_coding",
    });
    expect(modelList.url).toBe("https://api.kimi.com/coding/v1/models");
    expect(modelList.init.headers).toMatchObject({ "x-api-key": "sk-kimi-secret" });

    const probe = buildProviderConnectivityRequest({
      apiKey: "sk-kimi-secret",
      provider: {
        baseUrl: "https://api.kimi.com/coding/v1",
        displayName: "Kimi Coding Plan",
        id: "kimi-connectivity-probe",
        modelId: "kimi-for-coding",
        providerKey: "kimi_coding",
      },
    });
    expect(probe.url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(probe.init.headers).toMatchObject({ "x-api-key": "sk-kimi-secret" });
  });

  it("exposes kimi_coding through the whitelisted anthropic-compatible template category (W1)", () => {
    expect(listAnthropicCompatibleProviderTemplates().map((template) => template.id)).toEqual([
      "kimi_coding",
    ]);
    expect(isAnthropicCompatibleProviderTemplateId("kimi_coding")).toBe(true);
    expect(isAnthropicCompatibleProviderTemplateId("moonshot")).toBe(false);
    expect(getAnthropicCompatibleProviderTemplate("kimi_coding").providerKey).toBe("kimi_coding");

    // It appears in the API Keys selector group (paste-key flow), messages only.
    const apiKeysGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );
    const kimi = apiKeysGroup?.templates.find((template) => template.id === "kimi_coding");
    expect(kimi?.baseUrlMode).toBe("user_remote");
    expect(kimi?.providerType).toBe("api_key");
    expect(Object.keys(kimi?.endpoints ?? {})).toContain("messages");

    // Not part of the OpenAI-compatible category.
    expect(listOpenAICompatibleProviderTemplates().map((template) => template.id)).not.toContain(
      "kimi_coding",
    );
  });

  it("gives kimi_coding a supported quota probe hitting /coding/v1/usages with Bearer", async () => {
    const probe = resolveQuotaProbe("kimi_coding");
    expect(typeof quotaProbes.kimi_coding).toBe("function");
    expect(probe).toBe(quotaProbes.kimi_coding);

    const recorded: Array<{ headers: Headers; url: string }> = [];
    const result = await quotaProbes.kimi_coding({
      baseUrl: "https://api.kimi.com/coding/v1",
      credential: "secret-credential",
      fetch: async (url, init) => {
        recorded.push({ headers: new Headers(init?.headers), url: String(url) });
        return new Response(JSON.stringify({ limits: [], usage: {} }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(recorded[0]?.url).toBe("https://api.kimi.com/coding/v1/usages");
    // Quota auth is Bearer, distinct from the x-api-key used for messages egress.
    expect(recorded[0]?.headers.get("authorization")).toBe("Bearer secret-credential");
    expect(recorded[0]?.headers.get("accept")).toBe("application/json");
  });
});
