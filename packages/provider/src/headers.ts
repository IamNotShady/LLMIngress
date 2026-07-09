const providerResponseHeaderDenylist = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function readProviderResponseHeaders(headers: Headers): Record<string, string> {
  const providerHeaders: Record<string, string> = {};

  headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (!providerResponseHeaderDenylist.has(normalizedName)) {
      providerHeaders[normalizedName] = value;
    }
  });

  return providerHeaders;
}

export function mergeHttpHeaders(
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

export function readHttpHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === normalizedName,
  )?.[1];
}

export function mergeCommaSeparatedHeaderValues(
  ...values: Array<string | undefined>
): string | undefined {
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
