import {
  isRecord,
  isRetryableHttpStatus,
  joinProviderUrl,
  providerRequestTimeoutMs,
  readProviderRequestId,
  readResponseBody,
} from "./adapter-http.js";

export type AnthropicContentBlock = Record<string, unknown> & {
  type: string;
};

export type AnthropicMessageContent = string | AnthropicContentBlock[];

export type NormalizedAnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicMessageContent;
};

export type NormalizedAnthropicMessagesRequest = {
  maxOutputTokens: number;
  metadata?: Record<string, unknown>;
  messages: NormalizedAnthropicMessage[];
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
  ok: true;
  providerRequestId: string | null;
  statusCode: number;
};

export type AnthropicAdapterError = {
  body: unknown;
  errorCode: string;
  errorMessage: string;
  ok: false;
  retryable: boolean;
  statusCode: number | null;
};

export type AnthropicAdapterResult = AnthropicAdapterSuccess | AnthropicAdapterError;

export type AnthropicProviderAdapter = {
  messages: (input: {
    request: NormalizedAnthropicMessagesRequest;
    target: AnthropicProviderTarget;
  }) => Promise<AnthropicAdapterResult>;
};

type CreateAnthropicProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type AnthropicMessagesPayload = {
  max_tokens: number;
  metadata?: Record<string, unknown>;
  messages: NormalizedAnthropicMessage[];
  model: string;
  service_tier?: string;
  stream?: boolean;
  stop_sequences?: string[];
  system?: AnthropicMessageContent;
  temperature?: number;
  thinking?: Record<string, unknown>;
  tool_choice?: unknown;
  tools?: unknown[];
  top_k?: number;
  top_p?: number;
};

const anthropicVersion = "2023-06-01";

export function createAnthropicProviderAdapter(
  options: CreateAnthropicProviderAdapterOptions = {},
): AnthropicProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    messages: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildMessagesUrl(target.baseUrl), {
          body: JSON.stringify(buildAnthropicMessagesPayload(request, target)),
          headers: {
            "anthropic-version": anthropicVersion,
            "content-type": "application/json",
            "x-api-key": target.apiKey,
          },
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await readResponseBody(response);

        if (!response.ok) {
          return mapProviderError(response.status, body);
        }

        return {
          body,
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

export function buildAnthropicMessagesPayload(
  request: NormalizedAnthropicMessagesRequest,
  target: AnthropicProviderTarget,
): AnthropicMessagesPayload {
  return omitUnsupportedAnthropicSamplingParameters(
    omitUndefined({
      max_tokens: request.maxOutputTokens,
      metadata: request.metadata,
      messages: request.messages,
      model: target.modelId,
      service_tier: request.serviceTier,
      stream: request.stream,
      stop_sequences: request.stopSequences,
      system: request.system,
      temperature: request.temperature,
      thinking: request.thinking,
      tool_choice: request.toolChoice,
      tools: request.tools,
      top_k: request.topK,
      top_p: request.topP,
    }),
    target.modelId,
  ) as AnthropicMessagesPayload;
}

export function omitUnsupportedAnthropicSamplingParameters<T extends Record<string, unknown>>(
  payload: T,
  modelId: string,
): T {
  const normalizedModelId = modelId.toLowerCase();
  const cleaned = { ...payload };

  if (isOpus47OrNewer(normalizedModelId)) {
    delete cleaned.temperature;
    delete cleaned.top_k;
    delete cleaned.top_p;
    return cleaned;
  }

  if (normalizedModelId.includes("claude-sonnet-5")) {
    delete cleaned.temperature;
    delete cleaned.top_k;
    delete cleaned.top_p;
  }

  if (normalizedModelId.includes("claude-sonnet-4-6") && cleaned.temperature !== undefined) {
    delete cleaned.top_p;
  }

  return cleaned;
}

function buildMessagesUrl(baseUrl: string): string {
  return joinProviderUrl(baseUrl, "messages");
}

function mapProviderError(statusCode: number, body: unknown): AnthropicAdapterError {
  const providerError = readProviderError(body);

  return {
    body,
    errorCode: providerError.code,
    errorMessage: providerError.message,
    ok: false,
    retryable: isRetryableHttpStatus(statusCode),
    statusCode,
  };
}

function mapRequestFailure(error: unknown, timeoutMs: number): AnthropicAdapterError {
  return {
    body: null,
    errorCode: "provider_request_failed",
    errorMessage: isTimeoutError(error)
      ? `Provider request timed out after ${timeoutMs}ms.`
      : error instanceof Error
        ? error.message
        : "Provider request failed.",
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

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isOpus47OrNewer(modelId: string): boolean {
  const match = modelId.match(/\bclaude-opus-4[-.](\d+)/);
  return match ? Number(match[1]) >= 7 : false;
}
