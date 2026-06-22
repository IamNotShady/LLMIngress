import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
} from "../subscription.js";
import {
  type AnthropicAdapterResult,
  type AnthropicProviderAdapter,
  buildAnthropicMessagesPayload,
} from "./anthropic.js";
import type {
  NormalizedOpenAIResponsesInputMessage,
  OpenAIAdapterResult,
  OpenAIProviderAdapter,
} from "./openai.js";

type CreateSubscriptionAdapterOptions = {
  fetch?: typeof globalThis.fetch;
};

type CodexResponsesPayload = {
  input: Array<{
    content: Array<{ text: string; type: "input_text" }>;
    role: "assistant" | "system" | "user";
  }>;
  instructions: string;
  model: string;
  store: false;
  stream: boolean;
};

export function createCodexSubscriptionAdapter(
  options: CreateSubscriptionAdapterOptions = {},
): OpenAIProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    chatCompletion: async () => unsupportedOpenAIAdapterResult("codex_chat_unsupported"),
    response: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildCodexResponsesUrl(target.baseUrl), {
          body: JSON.stringify(buildCodexResponsesPayload(request.input, target.modelId)),
          headers: buildCodexSubscriptionHeaders(target.apiKey ?? ""),
          method: "POST",
        });
        const body = await readResponseBody(response);
        if (!response.ok) {
          return mapOpenAIProviderError(response.status, body);
        }
        return {
          body,
          ok: true,
          providerRequestId: readProviderRequestId(body),
          statusCode: response.status,
        };
      } catch (error) {
        return requestFailed(error);
      }
    },
  };
}

export function createClaudeCodeProviderAdapter(
  options: CreateSubscriptionAdapterOptions = {},
): AnthropicProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    messages: async ({ request, target }): Promise<AnthropicAdapterResult> => {
      try {
        const response = await fetchImpl(buildClaudeCodeMessagesUrl(target.baseUrl), {
          body: JSON.stringify(buildAnthropicMessagesPayload(request, target)),
          headers: buildClaudeCodeSubscriptionHeaders(target.apiKey ?? ""),
          method: "POST",
        });
        const body = await readResponseBody(response);
        if (!response.ok) {
          const mapped = mapOpenAIProviderError(response.status, body);
          return mapped;
        }
        return {
          body,
          ok: true,
          providerRequestId: readProviderRequestId(body),
          statusCode: response.status,
        };
      } catch (error) {
        return requestFailed(error);
      }
    },
  };
}

function buildCodexResponsesPayload(
  input: string | NormalizedOpenAIResponsesInputMessage[],
  modelId: string,
): CodexResponsesPayload {
  return {
    input: normalizeCodexInput(input),
    instructions: "You are a helpful assistant.",
    model: modelId,
    store: false,
    stream: true,
  };
}

function normalizeCodexInput(
  input: string | NormalizedOpenAIResponsesInputMessage[],
): CodexResponsesPayload["input"] {
  if (typeof input === "string") {
    return [{ content: [{ text: input, type: "input_text" }], role: "user" }];
  }
  return input.map((message) => ({
    content: [{ text: message.content, type: "input_text" }],
    role: message.role,
  }));
}

function unsupportedOpenAIAdapterResult(errorCode: string): OpenAIAdapterResult {
  return {
    body: null,
    errorCode,
    errorMessage: "Provider protocol is not supported for this endpoint.",
    ok: false,
    retryable: false,
    statusCode: 400,
  };
}

function requestFailed(error: unknown): OpenAIAdapterResult {
  return {
    body: null,
    errorCode: "provider_request_failed",
    errorMessage: error instanceof Error ? error.message : "Provider request failed.",
    ok: false,
    retryable: true,
    statusCode: null,
  };
}

function mapOpenAIProviderError(statusCode: number, body: unknown): OpenAIAdapterResult {
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

function readProviderRequestId(body: unknown): string | null {
  if (isRecord(body) && typeof body.id === "string") {
    return body.id;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
