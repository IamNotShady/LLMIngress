import { isRecord, joinUrl } from "@llmingress/util";
import {
  fetchCredentialedProviderRequest,
  isProviderRedirectRejectedError,
} from "../authenticated-http.js";
import { readProviderResponseHeaders } from "../headers.js";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
  buildMiniMaxSubscriptionHeaders,
  withClaudeCodeSystemPrompt,
} from "../subscription.js";
import {
  isRetryableHttpStatus,
  providerRequestTimeoutMs,
  readProviderRequestId,
  readResponseBody,
} from "./adapter-http.js";
import {
  type AnthropicAdapterResult,
  type AnthropicProviderAdapter,
  buildAnthropicMessagesPayload,
} from "./anthropic.js";
import type {
  NormalizedOpenAIResponsesRequest,
  OpenAIAdapterResult,
  OpenAIProviderAdapter,
} from "./openai.js";

type CreateSubscriptionAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

type CodexResponsesPayload = Record<string, unknown> & {
  model: string;
};

export function createCodexSubscriptionAdapter(
  options: CreateSubscriptionAdapterOptions = {},
): OpenAIProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    chatCompletion: async () => unsupportedOpenAIAdapterResult("codex_chat_unsupported"),
    response: async ({ headers, request, target }) => {
      try {
        const response = await fetchCredentialedProviderRequest(
          fetchImpl,
          buildCodexResponsesUrl(target.baseUrl),
          {
            body: JSON.stringify(buildCodexResponsesPayload(request, target.modelId)),
            headers: buildCodexSubscriptionHeaders(target.apiKey ?? "", headers),
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        const body = await readResponseBody(response);
        const responseHeaders = readProviderResponseHeaders(response.headers);
        if (!response.ok) {
          return mapOpenAIProviderError(response.status, body, responseHeaders);
        }
        return {
          body,
          headers: responseHeaders,
          ok: true,
          providerRequestId: readProviderRequestId(body),
          statusCode: response.status,
        };
      } catch (error) {
        return requestFailed(error, timeoutMs);
      }
    },
  };
}

export function createClaudeCodeProviderAdapter(
  options: CreateSubscriptionAdapterOptions = {},
): AnthropicProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    messages: async ({ headers, request, target }): Promise<AnthropicAdapterResult> => {
      try {
        const payload = buildAnthropicMessagesPayload(request, target);
        const response = await fetchCredentialedProviderRequest(
          fetchImpl,
          buildClaudeCodeMessagesUrl(target.baseUrl),
          {
            body: JSON.stringify({
              ...payload,
              system: withClaudeCodeSystemPrompt(payload.system),
            }),
            headers: buildClaudeCodeSubscriptionHeaders(target.apiKey ?? "", headers),
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        const body = await readResponseBody(response);
        const responseHeaders = readProviderResponseHeaders(response.headers);
        if (!response.ok) {
          const mapped = mapOpenAIProviderError(response.status, body, responseHeaders);
          return mapped;
        }
        return {
          body,
          headers: responseHeaders,
          ok: true,
          providerRequestId: readProviderRequestId(body),
          statusCode: response.status,
        };
      } catch (error) {
        return requestFailed(error, timeoutMs);
      }
    },
  };
}

export function createMiniMaxProviderAdapter(
  options: CreateSubscriptionAdapterOptions = {},
): AnthropicProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    messages: async ({ headers, request, target }): Promise<AnthropicAdapterResult> => {
      try {
        const payload = buildAnthropicMessagesPayload(request, target);
        const response = await fetchCredentialedProviderRequest(
          fetchImpl,
          // target.baseUrl is already resolved to the token's resource_url
          // (or the registry base); both already carry /anthropic/v1, so a
          // plain joinUrl is correct here — do not reuse claude_code's
          // appendV1Path, which would double the /v1 segment.
          joinUrl(target.baseUrl, "messages"),
          {
            body: JSON.stringify({
              ...payload,
              // The coding-plan endpoint expects the subscription identity
              // system block (the same withClaudeCodeSystemPrompt text);
              // the HTTP headers stay a plain Bearer with no client
              // impersonation.
              system: withClaudeCodeSystemPrompt(payload.system),
            }),
            headers: buildMiniMaxSubscriptionHeaders(target.apiKey ?? "", headers),
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        const body = await readResponseBody(response);
        const responseHeaders = readProviderResponseHeaders(response.headers);
        if (!response.ok) {
          return mapOpenAIProviderError(response.status, body, responseHeaders);
        }
        return {
          body,
          headers: responseHeaders,
          ok: true,
          providerRequestId: readProviderRequestId(body),
          statusCode: response.status,
        };
      } catch (error) {
        return requestFailed(error, timeoutMs);
      }
    },
  };
}

function buildCodexResponsesPayload(
  request: NormalizedOpenAIResponsesRequest,
  modelId: string,
): CodexResponsesPayload {
  return { ...request.payload, model: modelId };
}

function unsupportedOpenAIAdapterResult(errorCode: string): OpenAIAdapterResult {
  return {
    body: null,
    errorCode,
    errorMessage: "Provider protocol is not supported for this endpoint.",
    headers: {},
    ok: false,
    retryable: false,
    statusCode: 400,
  };
}

function requestFailed(error: unknown, timeoutMs: number): OpenAIAdapterResult {
  if (isProviderRedirectRejectedError(error)) {
    return {
      body: null,
      errorCode: error.code,
      errorMessage: error.message,
      headers: {},
      ok: false,
      retryable: error.retryable,
      statusCode: error.statusCode,
    };
  }

  return {
    body: null,
    errorCode: "provider_request_failed",
    errorMessage: isTimeoutError(error)
      ? `Provider request timed out after ${timeoutMs}ms.`
      : error instanceof Error
        ? error.message
        : "Provider request failed.",
    headers: {},
    ok: false,
    retryable: true,
    statusCode: null,
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function mapOpenAIProviderError(
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
): OpenAIAdapterResult {
  const providerError = readProviderError(body);
  return {
    body,
    errorCode: providerError.code,
    errorMessage: providerError.message,
    headers,
    ok: false,
    retryable: isRetryableHttpStatus(statusCode),
    statusCode,
  };
}

function readProviderError(body: unknown): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const rawCode = body.error.code ?? body.error.type ?? body.error.status;
    return {
      code: typeof rawCode === "string" ? rawCode : "provider_http_error",
      message:
        typeof body.error.message === "string" ? body.error.message : "Provider request failed.",
    };
  }
  return { code: "provider_http_error", message: "Provider request failed." };
}
