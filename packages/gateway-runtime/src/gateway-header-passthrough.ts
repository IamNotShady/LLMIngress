import { normalizeRouteTag } from "@llmingress/domain";

export type GatewayIncomingHeaders = Record<string, string | string[] | undefined>;

/** Names the candidate tag a tag-routed Virtual Model should serve this request with. */
export const gatewayRouteTagHeader = "x-llmingress-route-tag";

const providerRequestHeaderDenylist = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "x-api-key",
  // Routing input for this Gateway, never something an upstream should see.
  gatewayRouteTagHeader,
]);

/**
 * An unusable tag is kept as read rather than refused: it simply matches no
 * candidate, and the route falls back to the default one.
 */
export function readGatewayRequestedRouteTag(headers: GatewayIncomingHeaders): string | undefined {
  const rawValue = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === gatewayRouteTagHeader,
  )?.[1];
  const firstValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const requestedTag = firstValue ? normalizeRouteTag(firstValue) : "";
  return requestedTag || undefined;
}

export function readGatewayProviderRequestHeaders(
  headers: GatewayIncomingHeaders,
): Record<string, string> {
  const providerHeaders: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      providerRequestHeaderDenylist.has(name) ||
      name.startsWith("proxy-") ||
      name.startsWith("sec-")
    ) {
      continue;
    }

    const value = Array.isArray(rawValue)
      ? rawValue
          .map((entry) => entry.trim())
          .filter(Boolean)
          .join(", ")
      : rawValue?.trim();
    if (value) {
      providerHeaders[name] = value;
    }
  }

  return providerHeaders;
}

export function mergeGatewayHttpHeaders(
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

export function readGatewayHeaderValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === normalizedName,
  )?.[1];
}

function removeHeader(headers: Record<string, string>, name: string): void {
  const normalizedName = name.toLowerCase();
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      delete headers[headerName];
    }
  }
}
