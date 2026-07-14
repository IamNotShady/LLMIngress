import { isRecord, parsePositiveInt } from "@llmingress/util";

export function providerRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePositiveInt(env.PROVIDER_REQUEST_TIMEOUT_MS, 30_000);
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
