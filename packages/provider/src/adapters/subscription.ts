import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
  type CodexResponsesInput,
  normalizeCodexResponsesInput,
  withClaudeCodeSystemPrompt,
} from "../subscription.js";
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
};

type CodexResponsesPayload = {
  input: CodexResponsesInput;
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
          body: JSON.stringify(buildCodexResponsesPayload(request, target.modelId)),
          headers: buildCodexSubscriptionHeaders(target.apiKey ?? ""),
          method: "POST",
        });
        const body = await readResponseBody(response);
        if (!response.ok) {
          return mapOpenAIProviderError(response.status, body);
        }
        return {
          body: normalizeCodexResponseBody(body),
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
        const payload = buildAnthropicMessagesPayload(request, target);
        const response = await fetchImpl(buildClaudeCodeMessagesUrl(target.baseUrl), {
          body: JSON.stringify({
            ...payload,
            system: withClaudeCodeSystemPrompt(payload.system),
          }),
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
  request: NormalizedOpenAIResponsesRequest,
  modelId: string,
): CodexResponsesPayload {
  return {
    input: normalizeCodexResponsesInput(request.input),
    instructions: request.instructions ?? "You are a helpful assistant.",
    model: modelId,
    store: false,
    stream: true,
  };
}

function normalizeCodexResponseBody(body: unknown): unknown {
  if (!isRecord(body) || typeof body.raw !== "string") {
    return body;
  }
  const text = readCodexSseOutputText(body.raw);
  if (!text) {
    return body;
  }
  return {
    output: [
      {
        content: [{ text, type: "output_text" }],
        role: "assistant",
        type: "message",
      },
    ],
  };
}

function readCodexSseOutputText(raw: string): string | null {
  let deltaText = "";
  let completedText: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const event = JSON.parse(data);
      if (isRecord(event) && typeof event.delta === "string") {
        deltaText += event.delta;
      }
      completedText = readCodexCompletedOutputText(event) ?? completedText;
    } catch {
      // Ignore non-JSON SSE payloads.
    }
  }
  return completedText ?? (deltaText.trim() ? deltaText : null);
}

function readCodexCompletedOutputText(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.output_text === "string" && value.output_text.trim()) {
    return value.output_text.trim();
  }
  if (isRecord(value.response)) {
    return readCodexCompletedOutputText(value.response);
  }
  if (!Array.isArray(value.output)) {
    return null;
  }
  for (const output of value.output) {
    if (!isRecord(output) || !Array.isArray(output.content)) {
      continue;
    }
    const text = output.content
      .map((content) => (isRecord(content) && typeof content.text === "string" ? content.text : ""))
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }
  return null;
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
