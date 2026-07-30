import {
  resolveProviderRegistryEntry,
  type SubscriptionProviderKey,
} from "@llmingress/config/provider-registry";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import { isRecord } from "@llmingress/util";
import type { AnthropicContentBlock } from "./adapters/anthropic.js";

export type { SubscriptionProviderKey };

export const claudeCodeSystemPrompt =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export function withClaudeCodeSystemPrompt(system: unknown): AnthropicContentBlock[] {
  const identifier: AnthropicContentBlock = { text: claudeCodeSystemPrompt, type: "text" };
  if (Array.isArray(system)) {
    const [first] = system;
    if (isRecord(first) && first.text === claudeCodeSystemPrompt) {
      return system as AnthropicContentBlock[];
    }
    return [identifier, ...(system as AnthropicContentBlock[])];
  }
  if (typeof system === "string" && system.trim().length > 0) {
    if (system.trimStart().startsWith(claudeCodeSystemPrompt)) {
      return [{ text: system, type: "text" }];
    }
    return [identifier, { text: system, type: "text" }];
  }
  return [identifier];
}

export const codexClientVersion = "0.128.0";
export const codexOriginator = "codex_cli_rs";
export const codexUserAgent = "codex_cli_rs/0.0.0 (Unknown 0; unknown) unknown";
// The proxy inference endpoints gate on a versioned client User-Agent: an
// unversioned agent is rejected with HTTP 426 Upgrade Required. This single
// constant feeds both the User-Agent and the x-grok-client-version header; bump
// it here if the upstream proxy raises its minimum accepted client version.
export const grokClientVersion = "1.0.0";
export const grokTokenAuthHeaderValue = "xai-grok-cli";
export const claudeCodeBetaFlags =
  "claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27,effort-2025-11-24";
export const claudeCodeStainlessPackageVersion = "0.80.0";
export const claudeCodeStainlessRuntimeVersion = "v24.14.0";
export const claudeCodeUserAgent = "claude-cli/2.1.92 (external, sdk-cli)";

export function isSubscriptionProviderKey(
  providerKey: string | null | undefined,
): providerKey is SubscriptionProviderKey {
  return resolveProviderDescriptor(providerKey).subscription === true;
}

export function buildCodexSubscriptionHeaders(
  accessToken: string,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  return mergeHttpHeaders(requestHeaders, {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    originator: codexOriginator,
    "user-agent": codexUserAgent,
  });
}

export function buildClaudeCodeSubscriptionHeaders(
  accessToken: string,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  // The subscription Bearer owns auth; drop any forwarded x-api-key (the streaming path
  // injects `x-api-key: <credential>` for generic Anthropic) so it does not reach the
  // provider alongside the OAuth Bearer.
  const forwarded = stripHeader(requestHeaders, "x-api-key");
  return mergeHttpHeaders(forwarded, {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta":
      mergeCommaSeparatedHeaderValues(
        readHttpHeader(forwarded, "anthropic-beta"),
        claudeCodeBetaFlags,
      ) ?? claudeCodeBetaFlags,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": readHttpHeader(forwarded, "anthropic-version") ?? "2023-06-01",
    "content-type": "application/json",
    "user-agent": claudeCodeUserAgent,
    "x-app": "cli",
    "x-stainless-arch": readStainlessArch(),
    "x-stainless-helper-method": "stream",
    "x-stainless-lang": "js",
    "x-stainless-os": readStainlessOs(),
    "x-stainless-package-version": claudeCodeStainlessPackageVersion,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": claudeCodeStainlessRuntimeVersion,
    "x-stainless-timeout": "600",
  });
}

export function buildMiniMaxSubscriptionHeaders(
  accessToken: string,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  // MiniMax Coding Plan authenticates with a plain OAuth Bearer and Anthropic
  // version only: no claude-cli user-agent, no x-stainless-*, no anthropic-beta
  // impersonation. The subscription Bearer owns auth, so drop any forwarded
  // x-api-key (the streaming path injects `x-api-key: <credential>` for generic
  // Anthropic) rather than send it alongside the Bearer.
  const forwarded = stripHeader(requestHeaders, "x-api-key");
  return mergeHttpHeaders(forwarded, {
    "anthropic-version": readHttpHeader(forwarded, "anthropic-version") ?? "2023-06-01",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  });
}

export function buildGrokSubscriptionHeaders(
  accessToken: string,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  // Mirror the upstream client's identity headers so the proxy's version gate
  // (HTTP 426 without a versioned User-Agent) passes. The subscription Bearer
  // owns auth, so the grok headers are merged last and win over any forwarded
  // authorization. content-type is intentionally omitted here — the POST callers
  // add it; this builder owns only the six client-identity headers.
  return mergeHttpHeaders(requestHeaders, {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": `grok-shell/${grokClientVersion}`,
    "x-grok-client-mode": "headless",
    "x-grok-client-version": grokClientVersion,
    "x-xai-token-auth": grokTokenAuthHeaderValue,
  });
}

export function buildCodexModelListUrl(baseUrl: string): string {
  const url = appendPath(baseUrl, subscriptionModelListPath("openai_codex"));
  url.searchParams.set("client_version", codexClientVersion);
  return url.toString();
}

export function buildClaudeCodeModelListUrl(baseUrl: string): string {
  const url = appendV1Path(baseUrl, stripV1Prefix(subscriptionModelListPath("claude_code")));
  url.searchParams.set("limit", "100");
  return url.toString();
}

export function buildCodexResponsesUrl(baseUrl: string): string {
  return appendPath(baseUrl, subscriptionRoutePath("openai_codex", "responses")).toString();
}

export function buildClaudeCodeMessagesUrl(baseUrl: string): string {
  return appendV1Path(
    baseUrl,
    stripV1Prefix(subscriptionRoutePath("claude_code", "messages")),
  ).toString();
}

function subscriptionModelListPath(providerKey: SubscriptionProviderKey): string {
  const path = resolveProviderRegistryEntry(providerKey)?.modelListEndpoint?.path;
  if (!path) {
    throw new Error(`Missing model list endpoint for ${providerKey}.`);
  }
  return path;
}

function subscriptionRoutePath(
  providerKey: SubscriptionProviderKey,
  protocol: "messages" | "responses",
): string {
  const path = resolveProviderRegistryEntry(providerKey)?.endpoints[protocol]?.path;
  if (!path) {
    throw new Error(`Missing ${protocol} endpoint for ${providerKey}.`);
  }
  return path;
}

// The registry stores subscription catalog/route paths with their "v1/" prefix
// (e.g. "v1/models"); appendV1Path re-adds that prefix, so strip it first to
// keep the historical single-"/v1/" behavior for custom API roots unchanged.
function stripV1Prefix(path: string): string {
  return path.startsWith("v1/") ? path.slice("v1/".length) : path;
}

function appendV1Path(baseUrl: string, pathSuffix: string): URL {
  const url = new URL(baseUrl);
  const path = normalizePath(url.pathname);
  const prefix = path.endsWith("/v1") ? path : `${path}/v1`;
  url.pathname = `${prefix}/${pathSuffix}`.replaceAll(/\/{2,}/g, "/");
  return url;
}

function appendPath(baseUrl: string, pathSuffix: string): URL {
  const url = new URL(baseUrl);
  const path = normalizePath(url.pathname);
  url.pathname = `${path}/${pathSuffix}`.replaceAll(/\/{2,}/g, "/");
  return url;
}

function normalizePath(pathname: string): string {
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function readStainlessArch(): string {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return `Other:${process.arch}`;
  }
}

function readStainlessOs(): string {
  switch (process.platform) {
    case "darwin":
      return "MacOS";
    case "freebsd":
      return "FreeBSD";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return `Other:${process.platform}`;
  }
}

function mergeHttpHeaders(
  ...headerSets: Array<Record<string, string> | undefined>
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }
    for (const [name, value] of Object.entries(headers)) {
      removeHeader(output, name);
      output[name] = value;
    }
  }
  return output;
}

function readHttpHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === normalizedName,
  )?.[1];
}

function mergeCommaSeparatedHeaderValues(...values: Array<string | undefined>): string | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const entry of (value ?? "").split(",")) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged.length > 0 ? merged.join(",") : undefined;
}

function removeHeader(headers: Record<string, string>, name: string): void {
  const normalizedName = name.toLowerCase();
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      delete headers[headerName];
    }
  }
}

function stripHeader(
  headers: Record<string, string> | undefined,
  name: string,
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }
  const output = { ...headers };
  removeHeader(output, name);
  return output;
}
