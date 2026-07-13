import { gatewayCorsAllowedOrigins } from "@llmingress/gateway-runtime/gateway-env";

const defaultLocalhostNames = new Set(["127.0.0.1", "localhost", "::1"]);

export function isAllowedGatewayCorsOrigin(
  origin: string | undefined,
  configuredOrigins = gatewayCorsAllowedOrigins(),
): boolean {
  if (!origin) {
    return false;
  }

  const configured = parseConfiguredOrigins(configuredOrigins);
  if (configured.length > 0) {
    return configured.includes("*") || configured.includes(origin);
  }

  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      defaultLocalhostNames.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function gatewayCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !isAllowedGatewayCorsOrigin(origin)) {
    return {};
  }

  return {
    "access-control-allow-headers":
      "authorization, content-type, x-api-key, x-request-id, x-client-request-id, openai-organization, openai-project, openai-beta, anthropic-version, anthropic-beta",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": origin,
    "access-control-expose-headers":
      "retry-after, x-llmingress-request-metadata, x-llmingress-request-id, x-request-id, request-id, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens, anthropic-organization-id, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-requests-reset, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, anthropic-ratelimit-tokens-reset",
    vary: "Origin",
  };
}

function parseConfiguredOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
