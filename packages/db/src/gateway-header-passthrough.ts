export type GatewayIncomingHeaders = Record<string, string | string[] | undefined>;

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
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

export function readGatewayProviderRequestHeaders(
  headers: GatewayIncomingHeaders,
): Record<string, string> {
  const providerHeaders: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (providerRequestHeaderDenylist.has(name) || name.startsWith("proxy-")) {
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
