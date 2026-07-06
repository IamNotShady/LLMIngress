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
  isRecord,
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
  input: CodexResponsesInput;
  instructions: string;
  max_output_tokens?: number;
  model: string;
  parallel_tool_calls?: boolean;
  store?: unknown;
  stream: boolean;
  tool_choice?: NormalizedOpenAIResponsesRequest["toolChoice"];
  tools?: Record<string, unknown>[];
};

export function createCodexSubscriptionAdapter(
  options: CreateSubscriptionAdapterOptions = {},
): OpenAIProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();

  return {
    chatCompletion: async () => unsupportedOpenAIAdapterResult("codex_chat_unsupported"),
    response: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildCodexResponsesUrl(target.baseUrl), {
          body: JSON.stringify(buildCodexResponsesPayload(request, target.modelId)),
          headers: buildCodexSubscriptionHeaders(target.apiKey ?? ""),
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
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
          signal: AbortSignal.timeout(timeoutMs),
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
        return requestFailed(error, timeoutMs);
      }
    },
  };
}

function buildCodexResponsesPayload(
  request: NormalizedOpenAIResponsesRequest,
  modelId: string,
): CodexResponsesPayload {
  return {
    ...request.passthrough,
    input: normalizeCodexResponsesInput(request.input),
    instructions: request.instructions ?? "You are a helpful assistant.",
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.maxOutputTokens }),
    model: modelId,
    ...(request.parallelToolCalls === undefined
      ? {}
      : { parallel_tool_calls: request.parallelToolCalls }),
    store: request.passthrough?.store ?? false,
    stream: true,
    ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
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

function requestFailed(error: unknown, timeoutMs: number): OpenAIAdapterResult {
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

function mapOpenAIProviderError(statusCode: number, body: unknown): OpenAIAdapterResult {
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
