import { describe, expect, it } from "vitest";
import {
  defaultEndpointPathByProtocol,
  providerRegistry,
} from "../../packages/config/src/provider-registry";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { quotaProbes, resolveQuotaProbe } from "../../packages/provider/src/quota-probe";
import { joinUrl } from "../../packages/util/src/index";

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
    // This mirrors adapters/openai.ts::buildChatCompletionsUrl exactly.
    const glmUrl = joinUrl(
      providerRegistry.glm_coding.creation.mode === "template"
        ? (providerRegistry.glm_coding.creation.baseUrl ?? "")
        : "",
      defaultEndpointPathByProtocol.chat_completions,
    );
    expect(glmUrl).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");

    const qwenUrl = joinUrl(
      providerRegistry.qwen_token_plan.creation.mode === "template"
        ? (providerRegistry.qwen_token_plan.creation.baseUrl ?? "")
        : "",
      defaultEndpointPathByProtocol.chat_completions,
    );
    expect(qwenUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
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
