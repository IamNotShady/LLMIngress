import { openRouterAttributionHeaders } from "./adapters/openrouter.js";
import { mergeHttpHeaders } from "./headers.js";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
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
  buildUrl: joinProviderStreamingUrl,
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
        : joinProviderStreamingUrl(baseUrl, pathSuffix),
    supportsPathSuffix: (pathSuffix) => pathSuffix === "messages",
  },
  openai_codex: {
    buildHeaders: (apiKey, protocolHeaders) =>
      buildCodexSubscriptionHeaders(apiKey, protocolHeaders(apiKey)),
    buildUrl: (baseUrl, pathSuffix) =>
      pathSuffix === "responses"
        ? buildCodexResponsesUrl(baseUrl)
        : joinProviderStreamingUrl(baseUrl, pathSuffix),
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

export function joinProviderStreamingUrl(baseUrl: string, pathSuffix: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/${pathSuffix}`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}
