export type NormalizedOllamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type NormalizedOllamaChatRequest = {
  messages: NormalizedOllamaChatMessage[];
  stream?: boolean;
};

export type OllamaProviderTarget = {
  baseUrl: string;
};

export type OllamaChatTarget = OllamaProviderTarget & {
  modelId: string;
};

export type OllamaAdapterSuccess = {
  body: unknown;
  ok: true;
  providerRequestId: null;
  statusCode: number;
};

export type OllamaAdapterError = {
  body: unknown;
  errorCode: string;
  errorMessage: string;
  ok: false;
  retryable: boolean;
  statusCode: number | null;
};

export type OllamaAdapterResult = OllamaAdapterSuccess | OllamaAdapterError;

export type OllamaProviderAdapter = {
  chat: (input: {
    request: NormalizedOllamaChatRequest;
    target: OllamaChatTarget;
  }) => Promise<OllamaAdapterResult>;
  listModels: (input: { target: OllamaProviderTarget }) => Promise<OllamaAdapterResult>;
};

type CreateOllamaProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
};

type OllamaChatPayload = {
  messages: NormalizedOllamaChatMessage[];
  model: string;
  stream?: boolean;
};

const modelListPath = "/api/tags";
const chatPath = "/api/chat";

export function createOllamaProviderAdapter(
  options: CreateOllamaProviderAdapterOptions = {},
): OllamaProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    chat: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildTemplatePathUrl(target.baseUrl, chatPath), {
          body: JSON.stringify(buildChatPayload(request, target)),
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        });
        return readAdapterResult(response);
      } catch (error) {
        return mapNetworkError(error);
      }
    },
    listModels: async ({ target }) => {
      try {
        const response = await fetchImpl(buildTemplatePathUrl(target.baseUrl, modelListPath), {
          method: "GET",
        });
        return readAdapterResult(response);
      } catch (error) {
        return mapNetworkError(error);
      }
    },
  };
}

function buildChatPayload(
  request: NormalizedOllamaChatRequest,
  target: OllamaChatTarget,
): OllamaChatPayload {
  return omitUndefined({
    messages: request.messages,
    model: target.modelId,
    stream: request.stream,
  });
}

function buildTemplatePathUrl(baseUrl: string, templatePath: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}${templatePath}`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

async function readAdapterResult(response: Response): Promise<OllamaAdapterResult> {
  const body = await readResponseBody(response);

  if (!response.ok) {
    return mapProviderError(response.status, body);
  }

  return {
    body,
    ok: true,
    providerRequestId: null,
    statusCode: response.status,
  };
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

function mapProviderError(statusCode: number, body: unknown): OllamaAdapterError {
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

function mapNetworkError(error: unknown): OllamaAdapterError {
  return {
    body: null,
    errorCode: "provider_request_failed",
    errorMessage: error instanceof Error ? error.message : "Provider request failed.",
    ok: false,
    retryable: true,
    statusCode: null,
  };
}

function readProviderError(body: unknown): { code: string; message: string } {
  if (isRecord(body) && typeof body.error === "string") {
    return {
      code: "ollama_error",
      message: body.error,
    };
  }

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
