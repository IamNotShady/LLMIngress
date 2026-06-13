export type NormalizedOpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type NormalizedOpenAIChatRequest = {
  maxOutputTokens?: number;
  messages: NormalizedOpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
};

export type OpenAIProviderTarget = {
  apiKey: string;
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
};

type CreateOpenAIProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
};

type OpenAIChatCompletionsPayload = {
  max_tokens?: number;
  messages: NormalizedOpenAIChatMessage[];
  model: string;
  stream?: boolean;
  temperature?: number;
};

export function createOpenAIProviderAdapter(
  options: CreateOpenAIProviderAdapterOptions = {},
): OpenAIProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    chatCompletion: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildChatCompletionsUrl(target.baseUrl), {
          body: JSON.stringify(buildChatCompletionsPayload(request, target)),
          headers: {
            authorization: `Bearer ${target.apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
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
        return {
          body: null,
          errorCode: "provider_request_failed",
          errorMessage: error instanceof Error ? error.message : "Provider request failed.",
          ok: false,
          retryable: true,
          statusCode: null,
        };
      }
    },
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
  });
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/chat/completions`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
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

function mapProviderError(statusCode: number, body: unknown): OpenAIAdapterError {
  const providerError = readProviderError(body);

  return {
    body,
    errorCode: providerError.code,
    errorMessage: providerError.message,
    ok: false,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
  };
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

function readProviderRequestId(body: unknown): string | null {
  if (isRecord(body) && typeof body.id === "string") {
    return body.id;
  }
  return null;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
