export type NormalizedAnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export type NormalizedAnthropicMessagesRequest = {
  maxOutputTokens: number;
  messages: NormalizedAnthropicMessage[];
  stream?: boolean;
  system?: string;
  temperature?: number;
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
};

type AnthropicMessagesPayload = {
  max_tokens: number;
  messages: NormalizedAnthropicMessage[];
  model: string;
  stream?: boolean;
  system?: string;
  temperature?: number;
};

const anthropicVersion = "2023-06-01";

export function createAnthropicProviderAdapter(
  options: CreateAnthropicProviderAdapterOptions = {},
): AnthropicProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    messages: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildMessagesUrl(target.baseUrl), {
          body: JSON.stringify(buildMessagesPayload(request, target)),
          headers: {
            "anthropic-version": anthropicVersion,
            "content-type": "application/json",
            "x-api-key": target.apiKey,
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

function buildMessagesPayload(
  request: NormalizedAnthropicMessagesRequest,
  target: AnthropicProviderTarget,
): AnthropicMessagesPayload {
  return omitUndefined({
    max_tokens: request.maxOutputTokens,
    messages: request.messages,
    model: target.modelId,
    stream: request.stream,
    system: request.system,
    temperature: request.temperature,
  });
}

function buildMessagesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/messages`.replaceAll(/\/{2,}/g, "/");
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

function mapProviderError(statusCode: number, body: unknown): AnthropicAdapterError {
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
