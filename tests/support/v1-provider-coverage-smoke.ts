import { listOpenAICompatibleProviderTemplates } from "../../apps/console/src/server/provider-templates";

export type V1ProviderCoverageScenarioId =
  | "anthropic"
  | "google"
  | "lmstudio"
  | "llama_cpp"
  | "ollama"
  | "openai"
  | "openrouter";

export type V1ProviderCoverageEndpoint = "chat_completions" | "messages";
export type V1ProviderCoverageProviderType = "api_key" | "local";
export type V1ProviderCoverageAuthHeader = "authorization" | "x-api-key";

export type V1ProviderCoverageScenario = {
  baseUrl: string;
  displayName: string;
  endpoint: V1ProviderCoverageEndpoint;
  expectedAuthHeader: V1ProviderCoverageAuthHeader;
  expectedAuthValue: string;
  expectedProviderPath: string;
  id: V1ProviderCoverageScenarioId;
  modelDisplayName: string;
  modelId: string;
  providerApiKey: string;
  providerKey: string;
  providerTemplateId: string | null;
  providerType: V1ProviderCoverageProviderType;
  requestId: string;
  virtualModelDisplayName: string;
  virtualModelName: string;
};

export type V1ProviderCoverageLongTailTemplate = {
  baseUrl: string;
  displayName: string;
  id: string;
};

export type V1ProviderCoverageSmokePlan = {
  longTailTemplates: V1ProviderCoverageLongTailTemplate[];
  providerScenarios: V1ProviderCoverageScenario[];
};

export function buildV1ProviderCoverageSmokePlan(
  fakeProviderBaseUrl: string,
): V1ProviderCoverageSmokePlan {
  const baseUrl = fakeProviderBaseUrl.replace(/\/+$/, "");

  return {
    longTailTemplates: listOpenAICompatibleProviderTemplates().map((template) => ({
      baseUrl: template.baseUrl,
      displayName: template.displayName,
      id: template.id,
    })),
    providerScenarios: [
      {
        baseUrl: `${baseUrl}/openai/v1`,
        displayName: "OpenAI",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer sk-v1-openai-smoke-094",
        expectedProviderPath: "/openai/v1/chat/completions",
        id: "openai",
        modelDisplayName: "GPT 4.1 Mini",
        modelId: "gpt-4.1-mini",
        providerApiKey: "sk-v1-openai-smoke-094",
        providerKey: "openai",
        providerTemplateId: null,
        providerType: "api_key",
        requestId: "req_v1_provider_openai_094",
        virtualModelDisplayName: "V1 Smoke OpenAI",
        virtualModelName: "v1-smoke-openai",
      },
      {
        baseUrl: `${baseUrl}/anthropic/v1`,
        displayName: "Anthropic",
        endpoint: "messages",
        expectedAuthHeader: "x-api-key",
        expectedAuthValue: "sk-v1-anthropic-smoke-094",
        expectedProviderPath: "/anthropic/v1/messages",
        id: "anthropic",
        modelDisplayName: "Claude Sonnet 4.5",
        modelId: "claude-sonnet-4-5",
        providerApiKey: "sk-v1-anthropic-smoke-094",
        providerKey: "anthropic",
        providerTemplateId: null,
        providerType: "api_key",
        requestId: "req_v1_provider_anthropic_094",
        virtualModelDisplayName: "V1 Smoke Anthropic",
        virtualModelName: "v1-smoke-anthropic",
      },
      {
        baseUrl: `${baseUrl}/google/v1beta/openai`,
        displayName: "Google Gemini",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer gemini-v1-smoke-094",
        expectedProviderPath: "/google/v1beta/openai/chat/completions",
        id: "google",
        modelDisplayName: "Gemini 3.5 Flash",
        modelId: "gemini-3.5-flash",
        providerApiKey: "gemini-v1-smoke-094",
        providerKey: "google",
        providerTemplateId: "google",
        providerType: "api_key",
        requestId: "req_v1_provider_gemini_094",
        virtualModelDisplayName: "V1 Smoke Gemini",
        virtualModelName: "v1-smoke-gemini",
      },
      {
        baseUrl: `${baseUrl}/openrouter/api/v1`,
        displayName: "OpenRouter",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer sk-or-v1-smoke-094",
        expectedProviderPath: "/openrouter/api/v1/chat/completions",
        id: "openrouter",
        modelDisplayName: "OpenAI GPT-4o Mini",
        modelId: "openai/gpt-4o-mini",
        providerApiKey: "sk-or-v1-smoke-094",
        providerKey: "openrouter",
        providerTemplateId: "openrouter",
        providerType: "api_key",
        requestId: "req_v1_provider_openrouter_094",
        virtualModelDisplayName: "V1 Smoke OpenRouter",
        virtualModelName: "v1-smoke-openrouter",
      },
      {
        baseUrl: `${baseUrl}/ollama/v1`,
        displayName: "Ollama",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer local-v1-ollama-smoke-094",
        expectedProviderPath: "/ollama/v1/chat/completions",
        id: "ollama",
        modelDisplayName: "Ollama Local Model",
        modelId: "ollama-local-model",
        providerApiKey: "local-v1-ollama-smoke-094",
        providerKey: "ollama",
        providerTemplateId: "ollama",
        providerType: "local",
        requestId: "req_v1_provider_ollama_094",
        virtualModelDisplayName: "V1 Smoke Ollama",
        virtualModelName: "v1-smoke-ollama",
      },
      {
        baseUrl: `${baseUrl}/lmstudio/v1`,
        displayName: "LM Studio",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer local-v1-lmstudio-smoke-094",
        expectedProviderPath: "/lmstudio/v1/chat/completions",
        id: "lmstudio",
        modelDisplayName: "LM Studio Local Model",
        modelId: "lmstudio-local-model",
        providerApiKey: "local-v1-lmstudio-smoke-094",
        providerKey: "lmstudio",
        providerTemplateId: "lmstudio",
        providerType: "local",
        requestId: "req_v1_provider_lmstudio_094",
        virtualModelDisplayName: "V1 Smoke LM Studio",
        virtualModelName: "v1-smoke-lmstudio",
      },
      {
        baseUrl: `${baseUrl}/llama_cpp/v1`,
        displayName: "llama.cpp",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer local-v1-llama-cpp-smoke-094",
        expectedProviderPath: "/llama_cpp/v1/chat/completions",
        id: "llama_cpp",
        modelDisplayName: "llama.cpp Local Model",
        modelId: "llama-cpp-local-model",
        providerApiKey: "local-v1-llama-cpp-smoke-094",
        providerKey: "llama_cpp",
        providerTemplateId: "llama_cpp",
        providerType: "local",
        requestId: "req_v1_provider_llama_cpp_094",
        virtualModelDisplayName: "V1 Smoke llama.cpp",
        virtualModelName: "v1-smoke-llama-cpp",
      },
    ],
  };
}
