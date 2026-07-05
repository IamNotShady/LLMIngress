import { openRouterAttributionHeaders } from "./adapters/openrouter.js";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
  normalizeCodexResponsesInput,
  withClaudeCodeSystemPrompt,
} from "./subscription.js";

export type ProviderStreamingDialect = {
  buildHeaders: (
    apiKey: string,
    protocolHeaders: (apiKey: string) => Record<string, string>,
  ) => Record<string, string>;
  buildUrl: (baseUrl: string, pathSuffix: string) => string;
  supportsPathSuffix: (pathSuffix: string) => boolean;
  transformBody: (body: Record<string, unknown>, pathSuffix: string) => Record<string, unknown>;
  wantsStreamingUsage: (pathSuffix: string) => boolean;
};

const defaultDialect: ProviderStreamingDialect = {
  buildHeaders: (apiKey, protocolHeaders) => protocolHeaders(apiKey),
  buildUrl: joinProviderStreamingUrl,
  supportsPathSuffix: () => true,
  transformBody: (body) => body,
  wantsStreamingUsage: () => false,
};

const dialects: Record<string, Partial<ProviderStreamingDialect>> = {
  claude_code: {
    buildHeaders: (apiKey) => buildClaudeCodeSubscriptionHeaders(apiKey),
    buildUrl: (baseUrl, pathSuffix) =>
      pathSuffix === "messages"
        ? buildClaudeCodeMessagesUrl(baseUrl)
        : joinProviderStreamingUrl(baseUrl, pathSuffix),
    supportsPathSuffix: (pathSuffix) => pathSuffix === "messages",
    transformBody: (body, pathSuffix) =>
      pathSuffix === "messages"
        ? { ...body, system: withClaudeCodeSystemPrompt(body.system) }
        : body,
  },
  google: {
    wantsStreamingUsage: (pathSuffix) => pathSuffix === "chat/completions",
  },
  lmstudio: {
    wantsStreamingUsage: (pathSuffix) => pathSuffix === "chat/completions",
  },
  openai: {
    wantsStreamingUsage: (pathSuffix) => pathSuffix === "chat/completions",
  },
  openai_codex: {
    buildHeaders: (apiKey) => buildCodexSubscriptionHeaders(apiKey),
    buildUrl: (baseUrl, pathSuffix) =>
      pathSuffix === "responses"
        ? buildCodexResponsesUrl(baseUrl)
        : joinProviderStreamingUrl(baseUrl, pathSuffix),
    supportsPathSuffix: (pathSuffix) => pathSuffix === "responses",
    transformBody: (body, pathSuffix) =>
      pathSuffix === "responses" ? buildCodexStreamingResponsesBody(body) : body,
  },
  openrouter: {
    buildHeaders: (apiKey, protocolHeaders) => ({
      ...protocolHeaders(apiKey),
      ...openRouterAttributionHeaders,
    }),
  },
};

export function resolveProviderStreamingDialect(providerKey: string): ProviderStreamingDialect {
  return { ...defaultDialect, ...dialects[providerKey] };
}

export function joinProviderStreamingUrl(baseUrl: string, pathSuffix: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/${pathSuffix}`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

const codexUnsupportedResponsesParameters = [
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_p",
  "truncation",
];

function buildCodexStreamingResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of codexUnsupportedResponsesParameters) {
    delete cleaned[key];
  }
  cleaned.input = normalizeCodexResponsesInput(
    cleaned.input as Parameters<typeof normalizeCodexResponsesInput>[0],
  );
  if (typeof cleaned.instructions !== "string" || !cleaned.instructions.trim()) {
    cleaned.instructions = "You are a helpful assistant.";
  }
  return cleaned;
}
