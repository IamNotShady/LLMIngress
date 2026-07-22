import {
  providerSupportsRouteEndpointProtocol,
  type RouteEndpointProtocol,
} from "@llmingress/config/provider-registry";
import { joinUrl } from "@llmingress/util";
import { openRouterAttributionHeaders } from "./adapters/openrouter.js";
import { mergeHttpHeaders } from "./headers.js";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
  buildMiniMaxSubscriptionHeaders,
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

const defaultDialect: Omit<ProviderStreamingDialect, "supportsPathSuffix"> = {
  buildHeaders: (apiKey, protocolHeaders) => protocolHeaders(apiKey),
  buildUrl: joinUrl,
  transformBody: (body) => body,
};

// The streaming layer keys dialects by wire path suffix; map each suffix back
// to its routable protocol so support can be answered from the registry.
const routeProtocolByPathSuffix: Record<string, RouteEndpointProtocol> = {
  "chat/completions": "chat_completions",
  responses: "responses",
  messages: "messages",
};

const dialects: Record<string, Partial<ProviderStreamingDialect>> = {
  claude_code: {
    buildHeaders: (apiKey, protocolHeaders) =>
      buildClaudeCodeSubscriptionHeaders(apiKey, protocolHeaders(apiKey)),
    buildUrl: (baseUrl, pathSuffix) =>
      pathSuffix === "messages"
        ? buildClaudeCodeMessagesUrl(baseUrl)
        : joinUrl(baseUrl, pathSuffix),
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
  },
  minimax_coding: {
    // Bearer + anthropic-version only (strip x-api-key); no stainless/beta/UA
    // impersonation. buildUrl stays the default joinUrl since the base already
    // carries /anthropic/v1. transformBody injects the same identity system
    // block the non-streaming adapter does.
    buildHeaders: (apiKey, protocolHeaders) =>
      buildMiniMaxSubscriptionHeaders(apiKey, protocolHeaders(apiKey)),
    transformBody: (body, pathSuffix) =>
      pathSuffix === "messages"
        ? { ...body, system: withClaudeCodeSystemPrompt(body.system) }
        : body,
  },
  openrouter: {
    buildHeaders: (apiKey, protocolHeaders) =>
      mergeHttpHeaders(protocolHeaders(apiKey), openRouterAttributionHeaders),
  },
};

export function resolveProviderStreamingDialect(providerKey: string): ProviderStreamingDialect {
  return {
    ...defaultDialect,
    supportsPathSuffix: (pathSuffix) => {
      const protocol = routeProtocolByPathSuffix[pathSuffix];
      return protocol ? providerSupportsRouteEndpointProtocol(providerKey, protocol) : false;
    },
    ...dialects[providerKey],
  };
}
