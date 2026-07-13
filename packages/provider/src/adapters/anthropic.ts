import { isRecord, joinUrl, omitUndefined } from "@llmingress/util";
import {
  fetchCredentialedProviderRequest,
  isProviderRedirectRejectedError,
} from "../authenticated-http.js";
import { mergeHttpHeaders, readHttpHeader, readProviderResponseHeaders } from "../headers.js";
import {
  isRetryableHttpStatus,
  providerRequestTimeoutMs,
  readProviderRequestId,
  readResponseBody,
} from "./adapter-http.js";

export type AnthropicContentBlock = Record<string, unknown> & {
  type: string;
};

export type AnthropicMessageContent = string | AnthropicContentBlock[];

export type NormalizedAnthropicMessage = Record<string, unknown> & {
  role: "user" | "assistant";
  content: AnthropicMessageContent;
};

export type NormalizedAnthropicMessagesRequest = {
  maxOutputTokens: number;
  metadata?: Record<string, unknown>;
  messages: NormalizedAnthropicMessage[];
  payload: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  serviceTier?: string;
  stream?: boolean;
  stopSequences?: string[];
  system?: AnthropicMessageContent;
  temperature?: number;
  thinking?: Record<string, unknown>;
  toolChoice?: unknown;
  tools?: unknown[];
  topK?: number;
  topP?: number;
};

export type AnthropicProviderTarget = {
  apiKey: string;
  baseUrl: string;
  modelId: string;
};

export type AnthropicAdapterSuccess = {
  body: unknown;
  headers: Record<string, string>;
  ok: true;
  providerRequestId: string | null;
  statusCode: number;
};

export type AnthropicAdapterError = {
  body: unknown;
  errorCode: string;
  errorMessage: string;
  headers: Record<string, string>;
  ok: false;
  retryable: boolean;
  statusCode: number | null;
};

export type AnthropicAdapterResult = AnthropicAdapterSuccess | AnthropicAdapterError;

export type AnthropicProviderAdapter = {
  messages: (input: {
    headers?: Record<string, string>;
    request: NormalizedAnthropicMessagesRequest;
    target: AnthropicProviderTarget;
  }) => Promise<AnthropicAdapterResult>;
};

type CreateAnthropicProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type AnthropicMessagesPayload = Record<string, unknown> & {
  model: string;
};

const anthropicVersion = "2023-06-01";

export function createAnthropicProviderAdapter(
  options: CreateAnthropicProviderAdapterOptions = {},
): AnthropicProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    messages: async ({ headers, request, target }) => {
      try {
        const response = await fetchCredentialedProviderRequest(
          fetchImpl,
          buildAnthropicMessagesUrl(target.baseUrl),
          {
            body: JSON.stringify(buildAnthropicMessagesPayload(request, target)),
            headers: buildAnthropicProviderHeaders(target.apiKey, headers),
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        const body = await readResponseBody(response);
        const responseHeaders = readProviderResponseHeaders(response.headers);

        if (!response.ok) {
          return mapProviderError(response.status, body, responseHeaders);
        }

        return {
          body,
          headers: responseHeaders,
          ok: true,
          providerRequestId: readProviderRequestId(body),
          statusCode: response.status,
        };
      } catch (error) {
        return mapRequestFailure(error, timeoutMs);
      }
    },
  };
}

export function buildAnthropicProviderHeaders(
  apiKey: string,
  requestHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return mergeHttpHeaders(requestHeaders, {
    "anthropic-version": readHttpHeader(requestHeaders, "anthropic-version") ?? anthropicVersion,
    "content-type": "application/json",
    "x-api-key": apiKey,
  });
}

export function buildAnthropicMessagesPayload(
  request: NormalizedAnthropicMessagesRequest,
  target: AnthropicProviderTarget,
): AnthropicMessagesPayload {
  return omitUndefined({ ...request.payload, model: target.modelId }) as AnthropicMessagesPayload;
}

export function buildAnthropicMessagesUrl(baseUrl: string): string {
  return joinUrl(baseUrl, "messages");
}

function mapProviderError(
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
): AnthropicAdapterError {
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

function mapRequestFailure(error: unknown, timeoutMs: number): AnthropicAdapterError {
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

function readProviderError(body: unknown): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const code =
      typeof body.error.type === "string"
        ? body.error.type
        : typeof body.error.code === "string"
          ? body.error.code
          : "provider_http_error";
    const message =
      typeof body.error.message === "string" ? body.error.message : "Provider request failed.";
    return { code, message };
  }

  return {
    code: "provider_http_error",
    message: "Provider request failed.",
  };
}
