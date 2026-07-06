import type { AnthropicContentBlock } from "./adapters/anthropic.js";

export type SubscriptionProviderKey = "claude_code" | "openai_codex";

type OpenAIResponsesInputMessage = {
  content: string | Record<string, unknown>[];
  role: CodexResponsesInputMessage["role"];
};

type OpenAIResponsesInputItem = OpenAIResponsesInputMessage | Record<string, unknown>;

export type CodexResponsesInputMessage = {
  content: Array<{ text: string; type: "input_text" }>;
  role: "assistant" | "developer" | "system" | "user";
};

export type CodexResponsesInput = Array<CodexResponsesInputMessage | Record<string, unknown>>;

export function normalizeCodexResponsesInput(
  input: string | OpenAIResponsesInputItem[],
): CodexResponsesInput {
  if (typeof input === "string") {
    return [{ content: [{ text: input, type: "input_text" }], role: "user" }];
  }
  return input.map((item) =>
    isPlainTextResponsesInputMessage(item)
      ? {
          content: [{ text: item.content, type: "input_text" }],
          role: item.role,
        }
      : item,
  );
}

// Subscription (OAuth) /v1/messages requires an agent-identity string as the first
// system block, or Anthropic rejects/limits the request (observed as a 429
// rate_limit_error; per mnfst/manifest it also gates sonnet/opus vs haiku-only).
// Anthropic accepts either the Claude Code CLI identity or the Claude Agent SDK
// identity; we send the Agent SDK string (matching mnfst/manifest) since the gateway
// is a programmatic agent, not the CLI.
export const claudeCodeSystemPrompt =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// Prepend the Claude Code identifier as the first system block. Idempotent: if the
// caller already leads with the identifier (e.g. a real Claude Code client routed
// through the gateway), the system is returned unchanged.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainTextResponsesInputMessage(value: unknown): value is OpenAIResponsesInputMessage {
  if (!isRecord(value) || typeof value.type === "string") {
    return false;
  }
  return (
    typeof value.content === "string" &&
    (value.role === "assistant" ||
      value.role === "developer" ||
      value.role === "system" ||
      value.role === "user")
  );
}

export const codexClientVersion = "0.128.0";
export const codexOriginator = "codex_cli_rs";
export const codexUserAgent = "codex_cli_rs/0.0.0 (Unknown 0; unknown) unknown";
export const claudeCodeBetaFlags =
  "claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27,effort-2025-11-24";
export const claudeCodeStainlessPackageVersion = "0.80.0";
export const claudeCodeStainlessRuntimeVersion = "v24.14.0";
export const claudeCodeUserAgent = "claude-cli/2.1.92 (external, sdk-cli)";

export function isSubscriptionProviderKey(
  providerKey: string | null | undefined,
): providerKey is SubscriptionProviderKey {
  return providerKey === "openai_codex" || providerKey === "claude_code";
}

export function buildCodexSubscriptionHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    originator: codexOriginator,
    "user-agent": codexUserAgent,
  };
}

export function buildClaudeCodeSubscriptionHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": claudeCodeBetaFlags,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
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
  };
}

export function buildCodexModelListUrl(baseUrl: string): string {
  const url = appendPath(baseUrl, "codex/models");
  url.searchParams.set("client_version", codexClientVersion);
  return url.toString();
}

export function buildClaudeCodeModelListUrl(baseUrl: string): string {
  const url = appendV1Path(baseUrl, "models");
  url.searchParams.set("limit", "100");
  return url.toString();
}

export function buildCodexResponsesUrl(baseUrl: string): string {
  return appendPath(baseUrl, "codex/responses").toString();
}

export function buildClaudeCodeMessagesUrl(baseUrl: string): string {
  return appendV1Path(baseUrl, "messages").toString();
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
