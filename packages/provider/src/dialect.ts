import { joinUrl } from "@llmingress/util";
import { openRouterAttributionHeaders } from "./adapters/openrouter.js";
import { mergeHttpHeaders } from "./headers.js";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
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
};

const defaultDialect: ProviderStreamingDialect = {
  buildHeaders: (apiKey, protocolHeaders) => protocolHeaders(apiKey),
  buildUrl: joinUrl,
  supportsPathSuffix: () => true,
  transformBody: (body) => body,
};

const dialects: Record<string, Partial<ProviderStreamingDialect>> = {
  claude_code: {
    buildHeaders: (apiKey, protocolHeaders) =>
      buildClaudeCodeSubscriptionHeaders(apiKey, protocolHeaders(apiKey)),
    buildUrl: (baseUrl, pathSuffix) =>
      pathSuffix === "messages"
        ? buildClaudeCodeMessagesUrl(baseUrl)
        : joinUrl(baseUrl, pathSuffix),
    supportsPathSuffix: (pathSuffix) => pathSuffix === "messages",
    transformBody: (body, pathSuffix) =>
      pathSuffix === "messages"
        ? { ...body, system: withClaudeCodeSystemPrompt(body.system) }
        : body,
  },
  openai_codex: {
    buildHeaders: (apiKey, protocolHeaders) =>
      buildCodexSubscriptionHeaders(apiKey, protocolHeaders(apiKey)),
    buildUrl: (baseUrl, pathSuffix) =>
      pathSuffix === "responses" ? buildCodexResponsesUrl(baseUrl) : joinUrl(baseUrl, pathSuffix),
    supportsPathSuffix: (pathSuffix) => pathSuffix === "responses",
  },
  openrouter: {
    buildHeaders: (apiKey, protocolHeaders) =>
      mergeHttpHeaders(protocolHeaders(apiKey), openRouterAttributionHeaders),
  },
};

export function resolveProviderStreamingDialect(providerKey: string): ProviderStreamingDialect {
  return { ...defaultDialect, ...dialects[providerKey] };
}
