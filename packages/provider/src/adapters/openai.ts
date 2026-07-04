import {
  isRecord,
  isRetryableHttpStatus,
  joinProviderUrl,
  providerRequestTimeoutMs,
  readProviderRequestId,
  readResponseBody,
} from "./adapter-http.js";

export type NormalizedOpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Record<string, unknown>[];
};

export type NormalizedOpenAIChatRequest = {
  maxOutputTokens?: number;
  messages: NormalizedOpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  toolChoice?: string | Record<string, unknown>;
  tools?: Record<string, unknown>[];
};

export type NormalizedOpenAIResponsesInputMessage = {
  role: "developer" | "system" | "user" | "assistant";
  content: string;
};

export type NormalizedOpenAIResponsesRequest = {
  input: string | NormalizedOpenAIResponsesInputMessage[];
  instructions?: string;
  maxOutputTokens?: number;
  stream?: boolean;
  temperature?: number;
};

export type NormalizedOpenAIEmbeddingsRequest = {
  dimensions?: number;
  encodingFormat?: "base64" | "float";
  input: string | string[];
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

type OpenAIChatCompletionsPayload = {
  max_tokens?: number;
  messages: NormalizedOpenAIChatMessage[];
  model: string;
  stream?: boolean;
  temperature?: number;
  tool_choice?: NormalizedOpenAIChatRequest["toolChoice"];
  tools?: Record<string, unknown>[];
};

type OpenAIResponsesPayload = {
  input: string | NormalizedOpenAIResponsesInputMessage[];
  instructions?: string;
  max_output_tokens?: number;
  model: string;
  store: false;
  stream?: boolean;
  temperature?: number;
};

type OpenAIEmbeddingsPayload = {
  dimensions?: number;
  encoding_format?: NormalizedOpenAIEmbeddingsRequest["encodingFormat"];
  input: string | string[];
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
    max_tokens: request.maxOutputTokens,
    messages: request.messages,
    model: target.modelId,
    stream: request.stream,
    temperature: request.temperature,
    tool_choice: request.toolChoice,
    tools: request.tools,
  });
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return buildProviderUrl(baseUrl, "chat/completions");
}

function buildResponsesPayload(
  request: NormalizedOpenAIResponsesRequest,
  target: OpenAIProviderTarget,
): OpenAIResponsesPayload {
  return omitUndefined({
    input: request.input,
    instructions: request.instructions,
    max_output_tokens: request.maxOutputTokens,
    model: target.modelId,
    store: false,
    stream: request.stream,
    temperature: request.temperature,
  });
}

function buildResponsesUrl(baseUrl: string): string {
  return buildProviderUrl(baseUrl, "responses");
}

function buildEmbeddingsPayload(
  request: NormalizedOpenAIEmbeddingsRequest,
  target: OpenAIProviderTarget,
): OpenAIEmbeddingsPayload {
  return omitUndefined({
    dimensions: request.dimensions,
    encoding_format: request.encodingFormat,
    input: request.input,
    model: target.modelId,
  });
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
