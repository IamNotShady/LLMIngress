import { listOpenAICompatibleProviderTemplates } from "@llmingress/db/console-provider-templates";

export type ProviderCoverageScenarioId =
  | "anthropic"
  | "command_code"
  | "google"
  | "kimi_coding"
  | "lmstudio"
  | "llama_cpp"
  | "ollama"
  | "openai"
  | "openrouter";

export type ProviderCoverageEndpoint = "chat_completions" | "messages";
export type ProviderCoverageProviderType = "api_key" | "local";
export type ProviderCoverageAuthHeader = "authorization" | "x-api-key";

export type ProviderCoverageScenario = {
  baseUrl: string;
  displayName: string;
  endpoint: ProviderCoverageEndpoint;
  expectedAuthHeader: ProviderCoverageAuthHeader;
  expectedAuthValue: string;
  expectedProviderPath: string;
  id: ProviderCoverageScenarioId;
  modelDisplayName: string;
  modelId: string;
  providerApiKey: string;
  providerKey: string;
  providerTemplateId: string | null;
  providerType: ProviderCoverageProviderType;
  requestId: string;
  virtualModelDisplayName: string;
  virtualModelName: string;
};

export type ProviderCoverageLongTailTemplate = {
  baseUrl: string;
  displayName: string;
  id: string;
};

export type ProviderCoverageSmokePlan = {
  longTailTemplates: ProviderCoverageLongTailTemplate[];
  providerScenarios: ProviderCoverageScenario[];
};

export function buildProviderCoverageSmokePlan(
  fakeProviderBaseUrl: string,
): ProviderCoverageSmokePlan {
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
        expectedAuthValue: "Bearer sk-coverage-openai-smoke-094",
        expectedProviderPath: "/openai/v1/chat/completions",
        id: "openai",
        modelDisplayName: "GPT 4.1 Mini",
        modelId: "gpt-4.1-mini",
        providerApiKey: "sk-coverage-openai-smoke-094",
        providerKey: "openai",
        providerTemplateId: null,
        providerType: "api_key",
        requestId: "req_v1_provider_openai_094",
        virtualModelDisplayName: "Provider Smoke OpenAI",
        virtualModelName: "coverage-smoke-openai",
      },
      {
        baseUrl: `${baseUrl}/anthropic/v1`,
        displayName: "Anthropic",
        endpoint: "messages",
        expectedAuthHeader: "x-api-key",
        expectedAuthValue: "sk-coverage-anthropic-smoke-094",
        expectedProviderPath: "/anthropic/v1/messages",
        id: "anthropic",
        modelDisplayName: "Claude Sonnet 4.5",
        modelId: "claude-sonnet-4-5",
        providerApiKey: "sk-coverage-anthropic-smoke-094",
        providerKey: "anthropic",
        providerTemplateId: null,
        providerType: "api_key",
        requestId: "req_v1_provider_anthropic_094",
        virtualModelDisplayName: "Provider Smoke Anthropic",
        virtualModelName: "coverage-smoke-anthropic",
      },
      {
        // Kimi Coding Plan: Anthropic messages protocol + x-api-key (W1 category),
        // mirroring the anthropic scenario but as a paste-key template provider.
        baseUrl: `${baseUrl}/kimi/coding/v1`,
        displayName: "Kimi Coding Plan",
        endpoint: "messages",
        expectedAuthHeader: "x-api-key",
        expectedAuthValue: "sk-coverage-kimi-coding-smoke-094",
        expectedProviderPath: "/kimi/coding/v1/messages",
        id: "kimi_coding",
        modelDisplayName: "Kimi For Coding",
        modelId: "kimi-for-coding",
        providerApiKey: "sk-coverage-kimi-coding-smoke-094",
        providerKey: "kimi_coding",
        providerTemplateId: "kimi_coding",
        providerType: "api_key",
        requestId: "req_v1_provider_kimi_coding_094",
        virtualModelDisplayName: "Provider Smoke Kimi",
        virtualModelName: "coverage-smoke-kimi",
      },
      {
        // Command Code: OpenAI chat template category, but its second routable
        // face is Anthropic messages + x-api-key. This scenario pins the
        // messages egress (path + x-api-key, not authorization); the chat face
        // is covered by the long-tail smoke and the batch3 egress e2e.
        baseUrl: `${baseUrl}/command_code/provider/v1`,
        displayName: "Command Code",
        endpoint: "messages",
        expectedAuthHeader: "x-api-key",
        expectedAuthValue: "user_command-code-coverage-smoke-094",
        expectedProviderPath: "/command_code/provider/v1/messages",
        id: "command_code",
        modelDisplayName: "Claude Sonnet 4.5",
        modelId: "claude-sonnet-4-5",
        providerApiKey: "user_command-code-coverage-smoke-094",
        providerKey: "command_code",
        providerTemplateId: "command_code",
        providerType: "api_key",
        requestId: "req_v1_provider_command_code_094",
        virtualModelDisplayName: "Provider Smoke Command Code",
        virtualModelName: "coverage-smoke-command-code",
      },
      {
        baseUrl: `${baseUrl}/google/v1beta/openai`,
        displayName: "Google Gemini",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer gemini-coverage-smoke-094",
        expectedProviderPath: "/google/v1beta/openai/chat/completions",
        id: "google",
        modelDisplayName: "Gemini 3.5 Flash",
        modelId: "gemini-3.5-flash",
        providerApiKey: "gemini-coverage-smoke-094",
        providerKey: "google",
        providerTemplateId: "google",
        providerType: "api_key",
        requestId: "req_v1_provider_gemini_094",
        virtualModelDisplayName: "Provider Smoke Gemini",
        virtualModelName: "coverage-smoke-gemini",
      },
      {
        baseUrl: `${baseUrl}/openrouter/api/v1`,
        displayName: "OpenRouter",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer sk-or-coverage-smoke-094",
        expectedProviderPath: "/openrouter/api/v1/chat/completions",
        id: "openrouter",
        modelDisplayName: "OpenAI GPT-4o Mini",
        modelId: "openai/gpt-4o-mini",
        providerApiKey: "sk-or-coverage-smoke-094",
        providerKey: "openrouter",
        providerTemplateId: "openrouter",
        providerType: "api_key",
        requestId: "req_v1_provider_openrouter_094",
        virtualModelDisplayName: "Provider Smoke OpenRouter",
        virtualModelName: "coverage-smoke-openrouter",
      },
      {
        baseUrl: `${baseUrl}/ollama/v1`,
        displayName: "Ollama",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer local-coverage-ollama-smoke-094",
        expectedProviderPath: "/ollama/v1/chat/completions",
        id: "ollama",
        modelDisplayName: "Ollama Local Model",
        modelId: "ollama-local-model",
        providerApiKey: "local-coverage-ollama-smoke-094",
        providerKey: "ollama",
        providerTemplateId: "ollama",
        providerType: "local",
        requestId: "req_v1_provider_ollama_094",
        virtualModelDisplayName: "Provider Smoke Ollama",
        virtualModelName: "coverage-smoke-ollama",
      },
      {
        baseUrl: `${baseUrl}/lmstudio/v1`,
        displayName: "LM Studio",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer local-coverage-lmstudio-smoke-094",
        expectedProviderPath: "/lmstudio/v1/chat/completions",
        id: "lmstudio",
        modelDisplayName: "LM Studio Local Model",
        modelId: "lmstudio-local-model",
        providerApiKey: "local-coverage-lmstudio-smoke-094",
        providerKey: "lmstudio",
        providerTemplateId: "lmstudio",
        providerType: "local",
        requestId: "req_v1_provider_lmstudio_094",
        virtualModelDisplayName: "Provider Smoke LM Studio",
        virtualModelName: "coverage-smoke-lmstudio",
      },
      {
        baseUrl: `${baseUrl}/llama_cpp/v1`,
        displayName: "llama.cpp",
        endpoint: "chat_completions",
        expectedAuthHeader: "authorization",
        expectedAuthValue: "Bearer local-coverage-llama-cpp-smoke-094",
        expectedProviderPath: "/llama_cpp/v1/chat/completions",
        id: "llama_cpp",
        modelDisplayName: "llama.cpp Local Model",
        modelId: "llama-cpp-local-model",
        providerApiKey: "local-coverage-llama-cpp-smoke-094",
        providerKey: "llama_cpp",
        providerTemplateId: "llama_cpp",
        providerType: "local",
        requestId: "req_v1_provider_llama_cpp_094",
        virtualModelDisplayName: "Provider Smoke llama.cpp",
        virtualModelName: "coverage-smoke-llama-cpp",
      },
    ],
  };
}
