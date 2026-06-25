import { describe, expect, it } from "vitest";
import { buildV1ProviderCoverageSmokePlan } from "../support/v1-provider-coverage-smoke";

describe("feat-094 V1 provider coverage smoke", () => {
  it("plans core remote providers three local providers and supported long-tail templates", () => {
    const plan = buildV1ProviderCoverageSmokePlan("http://127.0.0.1:12345");

    expect(plan.providerScenarios.map((scenario) => scenario.id)).toEqual([
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "ollama",
      "lmstudio",
      "llama_cpp",
    ]);
    expect(
      plan.providerScenarios.map((scenario) => ({
        endpoint: scenario.endpoint,
        providerKey: scenario.providerKey,
        providerTemplateId: scenario.providerTemplateId,
        providerType: scenario.providerType,
      })),
    ).toEqual([
      {
        endpoint: "chat_completions",
        providerKey: "openai",
        providerTemplateId: null,
        providerType: "api_key",
      },
      {
        endpoint: "messages",
        providerKey: "anthropic",
        providerTemplateId: null,
        providerType: "api_key",
      },
      {
        endpoint: "chat_completions",
        providerKey: "google",
        providerTemplateId: "google",
        providerType: "api_key",
      },
      {
        endpoint: "chat_completions",
        providerKey: "openrouter",
        providerTemplateId: "openrouter",
        providerType: "api_key",
      },
      {
        endpoint: "chat_completions",
        providerKey: "ollama",
        providerTemplateId: "ollama",
        providerType: "local",
      },
      {
        endpoint: "chat_completions",
        providerKey: "lmstudio",
        providerTemplateId: "lmstudio",
        providerType: "local",
      },
      {
        endpoint: "chat_completions",
        providerKey: "llama_cpp",
        providerTemplateId: "llama_cpp",
        providerType: "local",
      },
    ]);
    expect(plan.longTailTemplates).toEqual([
      {
        baseUrl: "https://api.deepseek.com",
        displayName: "DeepSeek",
        id: "deepseek",
      },
      {
        baseUrl: "https://api.x.ai/v1",
        displayName: "xAI",
        id: "xai",
      },
      {
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        displayName: "Qwen",
        id: "qwen",
      },
      {
        baseUrl: "https://api.moonshot.ai/v1",
        displayName: "Moonshot/Kimi",
        id: "moonshot",
      },
      {
        baseUrl: "https://api.minimax.io/v1",
        displayName: "MiniMax",
        id: "minimax",
      },
      {
        baseUrl: "https://api.z.ai/api/paas/v4",
        displayName: "Z.ai",
        id: "zai",
      },
    ]);
  });
});
