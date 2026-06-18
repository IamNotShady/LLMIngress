import {
  createOpenAIProviderAdapter,
  type OpenAIAdapterError,
  type OpenAIProviderAdapter,
} from "./openai.js";

export const openRouterAttributionHeaders = {
  "HTTP-Referer": "https://llmingress.local",
  "X-OpenRouter-Title": "LLMIngress",
} as const;

type CreateOpenRouterProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
};

export function createOpenRouterProviderAdapter(
  options: CreateOpenRouterProviderAdapterOptions = {},
): OpenAIProviderAdapter {
  return createOpenAIProviderAdapter({
    fetch: options.fetch,
    headers: openRouterAttributionHeaders,
    mapProviderError: mapOpenRouterProviderError,
  });
}

function mapOpenRouterProviderError(statusCode: number, body: unknown): OpenAIAdapterError {
  const providerError = readOpenRouterProviderError(statusCode, body);

  return {
    body,
    errorCode: providerError.code,
    errorMessage: providerError.message,
    ok: false,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
  };
}

function readOpenRouterProviderError(
  statusCode: number,
  body: unknown,
): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const rawCode = body.error.code;
    const code =
      typeof rawCode === "string" && rawCode.trim()
        ? rawCode
        : typeof rawCode === "number" && Number.isInteger(rawCode)
          ? `openrouter_${rawCode}`
          : `openrouter_${statusCode}`;
    const message =
      typeof body.error.message === "string" && body.error.message.trim()
        ? body.error.message
        : "OpenRouter request failed.";
    return { code, message };
  }

  return {
    code: `openrouter_${statusCode}`,
    message: "OpenRouter request failed.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
