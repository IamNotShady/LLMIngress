export function joinProviderUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function readProviderRequestId(body: unknown): string | null {
  if (isRecord(body) && typeof body.id === "string") {
    return body.id;
  }
  return null;
}

export function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
