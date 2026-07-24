import { describe, expect, it } from "vitest";
import { buildProviderCoverageSmokePlan } from "../support/provider-coverage-smoke";

describe("provider coverage", () => {
  it("plans core remote providers three local providers and supported long-tail templates", () => {
    const plan = buildProviderCoverageSmokePlan("http://127.0.0.1:12345");

    expect(plan.providerScenarios.map((scenario) => scenario.id)).toEqual([
      "openai",
      "anthropic",
      "kimi_coding",
      "command_code",
      "opencode_go",
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
        endpoint: "messages",
        providerKey: "kimi_coding",
        providerTemplateId: "kimi_coding",
        providerType: "api_key",
      },
      {
        endpoint: "messages",
        providerKey: "command_code",
        providerTemplateId: "command_code",
        providerType: "api_key",
      },
      {
        endpoint: "messages",
        providerKey: "opencode_go",
        providerTemplateId: "opencode_go",
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
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        displayName: "Qwen Token Plan",
        id: "qwen_token_plan",
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
      {
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        displayName: "GLM Coding Plan",
        id: "glm_coding",
      },
      {
        baseUrl: "https://api.commandcode.ai/provider/v1",
        displayName: "Command Code",
        id: "command_code",
      },
      {
        baseUrl: "https://inference-api.nousresearch.com/v1",
        displayName: "NousResearch",
        id: "nous",
      },
      {
        baseUrl: "https://api.cline.bot/api/v1",
        displayName: "ClinePass",
        id: "cline_pass",
      },
      {
        baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
        displayName: "BytePlus ModelArk",
        id: "byteplus_coding",
      },
      {
        baseUrl: "https://api.mistral.ai/v1",
        displayName: "Mistral",
        id: "mistral",
      },
      {
        baseUrl: "https://api.groq.com/openai/v1",
        displayName: "Groq",
        id: "groq",
      },
      {
        baseUrl: "https://api.cerebras.ai/v1",
        displayName: "Cerebras",
        id: "cerebras",
      },
      {
        baseUrl: "https://api.fireworks.ai/inference/v1",
        displayName: "Fireworks AI",
        id: "fireworks",
      },
      {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        displayName: "NVIDIA NIM",
        id: "nvidia",
      },
      {
        baseUrl: "https://api.xiaomimimo.com/v1",
        displayName: "Xiaomi MiMo",
        id: "xiaomi",
      },
      {
        baseUrl: "https://ollama.com/v1",
        displayName: "Ollama Cloud",
        id: "ollama_cloud",
      },
    ]);
  });
});
