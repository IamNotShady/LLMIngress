export type SubscriptionProviderKey = "claude_code" | "openai_codex";

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
  return mergeHttpHeaders(requestHeaders, {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta":
      mergeCommaSeparatedHeaderValues(
        readHttpHeader(requestHeaders, "anthropic-beta"),
        claudeCodeBetaFlags,
      ) ?? claudeCodeBetaFlags,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": readHttpHeader(requestHeaders, "anthropic-version") ?? "2023-06-01",
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
