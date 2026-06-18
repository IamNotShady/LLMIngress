import type {
  NormalizedOpenAIChatMessage,
  NormalizedOpenAIChatRequest,
  OpenAIAdapterError,
  OpenAIProviderAdapter,
  OpenAIProviderTarget,
} from "./openai.js";

type CreateGeminiProviderAdapterOptions = {
  fetch?: typeof globalThis.fetch;
};

type GeminiContent = {
  parts: Array<{ text: string }>;
  role?: "model" | "user";
};

type GeminiGenerateContentPayload = {
  contents: GeminiContent[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
};

export function createGeminiProviderAdapter(
  options: CreateGeminiProviderAdapterOptions = {},
): OpenAIProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    chatCompletion: async ({ request, target }) => {
      try {
        const response = await fetchImpl(buildGenerateContentUrl(target), {
          body: JSON.stringify(buildGenerateContentPayload(request)),
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": target.apiKey,
          },
          method: "POST",
        });
        const body = await readResponseBody(response);

        if (!response.ok) {
          return mapGeminiProviderError(response.status, body);
        }

        const responseBody = mapGeminiResponseToOpenAIChat(body, target.modelId);
        return {
          body: responseBody,
          ok: true,
          providerRequestId: readGeminiResponseId(body),
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

function buildGenerateContentPayload(
  request: NormalizedOpenAIChatRequest,
): GeminiGenerateContentPayload {
  const systemMessages = request.messages.filter((message) => message.role === "system");
  const contents = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      parts: [{ text: message.content }],
      role: mapGeminiRole(message),
    }));
  const generationConfig = {
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
  };

  return omitUndefined({
    contents,
    generationConfig: omitUndefined(generationConfig),
    systemInstruction:
      systemMessages.length > 0
        ? {
            parts: systemMessages.map((message) => ({ text: message.content })),
          }
        : undefined,
  });
}

function mapGeminiRole(message: NormalizedOpenAIChatMessage): "model" | "user" {
  return message.role === "assistant" ? "model" : "user";
}

function buildGenerateContentUrl(target: OpenAIProviderTarget): string {
  const url = new URL(target.baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const modelName = target.modelId.startsWith("models/")
    ? target.modelId
    : `models/${target.modelId}`;
  url.pathname = `${path}/${modelName}:generateContent`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

function mapGeminiResponseToOpenAIChat(body: unknown, modelId: string): unknown {
  const text = readGeminiResponseText(body);
  const usage = readGeminiUsage(body);

  return omitUndefined({
    choices: [
      {
        finish_reason: mapFinishReason(readGeminiFinishReason(body)),
        index: 0,
        message: {
          content: text,
          role: "assistant",
        },
      },
    ],
    id: readGeminiResponseId(body) ?? `gemini-${modelId}`,
    model: modelId,
    object: "chat.completion",
    usage,
  });
}

function readGeminiResponseText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.candidates)) {
    return "";
  }
  const candidate = body.candidates.find(isRecord);
  if (!candidate || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return "";
  }
  return candidate.content.parts
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function readGeminiFinishReason(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.candidates)) {
    return undefined;
  }
  const candidate = body.candidates.find(isRecord);
  return typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined;
}

function mapFinishReason(reason: string | undefined): string | null {
  if (!reason) {
    return null;
  }
  if (reason === "STOP") {
    return "stop";
  }
  if (reason === "MAX_TOKENS") {
    return "length";
  }
  return reason.toLowerCase();
}

function readGeminiUsage(body: unknown):
  | {
      completion_tokens?: number;
      prompt_tokens?: number;
      total_tokens?: number;
    }
  | undefined {
  if (!isRecord(body) || !isRecord(body.usageMetadata)) {
    return undefined;
  }

  return omitUndefined({
    completion_tokens: readInteger(body.usageMetadata.candidatesTokenCount),
    prompt_tokens: readInteger(body.usageMetadata.promptTokenCount),
    total_tokens: readInteger(body.usageMetadata.totalTokenCount),
  });
}

function readGeminiResponseId(body: unknown): string | null {
  return isRecord(body) && typeof body.responseId === "string" && body.responseId.trim()
    ? body.responseId
    : null;
}

function mapGeminiProviderError(statusCode: number, body: unknown): OpenAIAdapterError {
  const providerError = readGeminiProviderError(statusCode, body);
  return {
    body,
    errorCode: providerError.code,
    errorMessage: providerError.message,
    ok: false,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
  };
}

function readGeminiProviderError(
  statusCode: number,
  body: unknown,
): { code: string; message: string } {
  if (isRecord(body) && isRecord(body.error)) {
    const status = body.error.status;
    const code =
      typeof status === "string" && status.trim() ? `gemini_${status}` : `gemini_${statusCode}`;
    const message =
      typeof body.error.message === "string" && body.error.message.trim()
        ? body.error.message
        : "Gemini request failed.";
    return { code, message };
  }

  return {
    code: `gemini_${statusCode}`,
    message: "Gemini request failed.",
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

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
