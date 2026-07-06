import {
  isRecord,
  isRetryableHttpStatus,
  joinProviderUrl,
  providerRequestTimeoutMs,
  readProviderRequestId,
  readResponseBody,
} from "./adapter-http.js";

export type NormalizedOpenAIChatMessage = Record<string, unknown> & {
  role: "assistant" | "developer" | "function" | "system" | "tool" | "user";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Record<string, unknown>[];
};

export type OpenAIChatMaxOutputTokenField = "max_completion_tokens" | "max_tokens";

export type NormalizedOpenAIChatRequest = {
  maxOutputTokenField?: OpenAIChatMaxOutputTokenField;
  maxOutputTokens?: number;
  messages: NormalizedOpenAIChatMessage[];
  payload: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  stream?: boolean;
  temperature?: number;
  toolChoice?: string | Record<string, unknown>;
  tools?: Record<string, unknown>[];
};

export type NormalizedOpenAIResponsesInputMessage = Record<string, unknown> & {
  role: "developer" | "system" | "user" | "assistant";
  content: unknown;
};

export type NormalizedOpenAIResponsesInputItem =
  | NormalizedOpenAIResponsesInputMessage
  | Record<string, unknown>;

export type NormalizedOpenAIResponsesRequest = {
  input: string | NormalizedOpenAIResponsesInputItem[];
  instructions?: string | null;
  maxOutputTokens?: number;
  payload: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  parallelToolCalls?: boolean;
  stream?: boolean;
  temperature?: number;
  toolChoice?: string | Record<string, unknown>;
  tools?: Record<string, unknown>[];
};

export type NormalizedOpenAIEmbeddingsRequest = {
  dimensions?: number;
  encodingFormat?: "base64" | "float";
  input: string | string[] | number[] | number[][];
  payload: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
};

export type OpenAIProviderTarget = {
  apiKey?: string | null;
  baseUrl: string;
  modelId: string;
};

export type OpenAIAdapterSuccess = {
  body: unknown;
  ok: true;
  providerRequestId: string | null;
  statusCode: number;
};

export type OpenAIAdapterError = {
  body: unknown;
  errorCode: string;
  errorMessage: string;
  ok: false;
  retryable: boolean;
  statusCode: number | null;
};

export type OpenAIAdapterResult = OpenAIAdapterSuccess | OpenAIAdapterError;

export type OpenAIProviderAdapter = {
  chatCompletion: (input: {
    request: NormalizedOpenAIChatRequest;
    target: OpenAIProviderTarget;
  }) => Promise<OpenAIAdapterResult>;
  embeddings?: (input: {
    request: NormalizedOpenAIEmbeddingsRequest;
    target: OpenAIProviderTarget;
  }) => Promise<OpenAIAdapterResult>;
  response?: (input: {
    request: NormalizedOpenAIResponsesRequest;
    target: OpenAIProviderTarget;
  }) => Promise<OpenAIAdapterResult>;
};

type CreateOpenAIProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  mapProviderError?: (statusCode: number, body: unknown) => OpenAIAdapterError;
  timeoutMs?: number;
};

type OpenAIChatCompletionsPayload = Record<string, unknown> & {
  max_tokens?: number;
  messages: NormalizedOpenAIChatMessage[];
  model: string;
  stream?: boolean;
  temperature?: number;
  tool_choice?: NormalizedOpenAIChatRequest["toolChoice"];
  tools?: Record<string, unknown>[];
};

type OpenAIResponsesPayload = Record<string, unknown> & {
  input: NormalizedOpenAIResponsesRequest["input"];
  instructions?: string | null;
  max_output_tokens?: number;
  model: string;
  parallel_tool_calls?: boolean;
  store?: boolean;
  stream?: boolean;
  temperature?: number;
  tool_choice?: NormalizedOpenAIResponsesRequest["toolChoice"];
  tools?: Record<string, unknown>[];
};

type OpenAIEmbeddingsPayload = Record<string, unknown> & {
  dimensions?: number;
  encoding_format?: NormalizedOpenAIEmbeddingsRequest["encodingFormat"];
  input: NormalizedOpenAIEmbeddingsRequest["input"];
  model: string;
};

export function createOpenAIProviderAdapter(
  options: CreateOpenAIProviderAdapterOptions = {},
): OpenAIProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const mapError = options.mapProviderError ?? mapProviderError;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    chatCompletion: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildChatCompletionsUrl(target.baseUrl), {
          body: JSON.stringify(buildChatCompletionsPayload(request, target)),
          headers: buildProviderHeaders(target.apiKey, options.headers),
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await readResponseBody(response);

        if (!response.ok) {
          return mapError(response.status, body);
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
    embeddings: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildEmbeddingsUrl(target.baseUrl), {
          body: JSON.stringify(buildEmbeddingsPayload(request, target)),
          headers: buildProviderHeaders(target.apiKey, options.headers),
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await readResponseBody(response);

        if (!response.ok) {
          return mapError(response.status, body);
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
    response: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildResponsesUrl(target.baseUrl), {
          body: JSON.stringify(buildResponsesPayload(request, target)),
          headers: buildProviderHeaders(target.apiKey, options.headers),
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await readResponseBody(response);

        if (!response.ok) {
          return mapError(response.status, body);
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

function buildProviderHeaders(
  apiKey: string | null | undefined,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...extraHeaders,
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function buildChatCompletionsPayload(
  request: NormalizedOpenAIChatRequest,
  target: OpenAIProviderTarget,
): OpenAIChatCompletionsPayload {
  return omitUndefined({
    ...request.payload,
    model: target.modelId,
  }) as OpenAIChatCompletionsPayload;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return buildProviderUrl(baseUrl, "chat/completions");
}

function buildResponsesPayload(
  request: NormalizedOpenAIResponsesRequest,
  target: OpenAIProviderTarget,
): OpenAIResponsesPayload {
  return omitUndefined({ ...request.payload, model: target.modelId }) as OpenAIResponsesPayload;
}

function buildResponsesUrl(baseUrl: string): string {
  return buildProviderUrl(baseUrl, "responses");
}

function buildEmbeddingsPayload(
  request: NormalizedOpenAIEmbeddingsRequest,
  target: OpenAIProviderTarget,
): OpenAIEmbeddingsPayload {
  return omitUndefined({ ...request.payload, model: target.modelId }) as OpenAIEmbeddingsPayload;
}

function buildEmbeddingsUrl(baseUrl: string): string {
  return buildProviderUrl(baseUrl, "embeddings");
}

function buildProviderUrl(baseUrl: string, suffix: string): string {
  return joinProviderUrl(baseUrl, suffix);
}

function mapProviderError(statusCode: number, body: unknown): OpenAIAdapterError {
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

function mapRequestFailure(error: unknown, timeoutMs: number): OpenAIAdapterError {
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
    const code = typeof body.error.code === "string" ? body.error.code : "provider_http_error";
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
