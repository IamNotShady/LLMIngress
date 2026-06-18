const defaultLocalhostNames = new Set(["127.0.0.1", "localhost", "::1"]);

export function isAllowedGatewayCorsOrigin(
  origin: string | undefined,
  configuredOrigins = process.env.GATEWAY_CORS_ALLOWED_ORIGINS,
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
    "access-control-allow-headers": "authorization, content-type, x-api-key, x-request-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "retry-after, x-llmingress-request-metadata, x-request-id",
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
