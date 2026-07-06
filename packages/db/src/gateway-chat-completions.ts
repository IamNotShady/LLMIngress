import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIChatMessage,
  type NormalizedOpenAIChatRequest,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { createOpenRouterProviderAdapter } from "@llmingress/provider/openrouter";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import type { GatewayConfigSnapshot } from "./gateway-config-reload.ts";
import {
  createGatewayErrorBody,
  type GatewayErrorBody,
  GatewayPipelineError,
} from "./gateway-errors.ts";
import {
  executeGatewayProtocolRequest,
  type GatewayProtocolResponse,
} from "./gateway-protocol-request.ts";
import { buildOpenAIChatCompletionRequestMetadata } from "./gateway-request-metadata.ts";
import { isRecord, omitUndefined } from "./gateway-runtime-helpers.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayChatCompletionResponse = GatewayProtocolResponse;

export type GatewayChatCompletionRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIChatRequest;
};

export type GatewayChatCompletionRequestFailure = {
  body: GatewayErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayChatCompletionRequestResult =
  | GatewayChatCompletionRequestFailure
  | GatewayChatCompletionRequestSuccess;

const maxChatCompletionOutputTokens = 16_384;
const chatPassthroughParameterKeys = [
  "frequency_penalty",
  "logprobs",
  "parallel_tool_calls",
  "presence_penalty",
  "response_format",
  "seed",
  "stop",
  "top_logprobs",
  "top_p",
  "user",
] as const;

export function normalizeOpenAIChatCompletionRequest(
  body: unknown,
  requestId: string,
): GatewayChatCompletionRequestResult {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidChatRequest(requestId);
  }

  const messages = body.messages.map(readOpenAIChatMessage);
  if (messages.some((message) => !message)) {
    return invalidChatRequest(requestId);
  }

  const maxOutputTokens = readOptionalPositiveInteger(
    body.max_completion_tokens ?? body.max_tokens,
  );
  if (maxOutputTokens === null) {
    return invalidChatRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidChatRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidChatRequest(requestId);
  }
  const tools = readOptionalObjectArray(body.tools);
  if (tools === null) {
    return invalidChatRequest(requestId);
  }
  const toolChoice = readOptionalOpenAIToolChoice(body.tool_choice);
  if (toolChoice === null) {
    return invalidChatRequest(requestId);
  }

  const passthrough = readChatPassthroughParameters(body);

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages: messages as NormalizedOpenAIChatMessage[],
      passthrough,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
      toolChoice,
      tools,
    }),
  };
}

export async function executeGatewayOpenAIChatCompletion(input: {
  agentId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl?: string;
  masterKeySource?: MasterKeySource;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayChatCompletionResponse> {
  const genericAdapter = input.adapter ?? createOpenAIProviderAdapter();
  const openRouterAdapter = input.adapter ?? createOpenRouterProviderAdapter();

  return executeGatewayProtocolRequest<NormalizedOpenAIChatRequest, OpenAIAdapterSuccess>({
    ...input,
    protocol: "chat_completions",
    spec: {
      buildRequestMetadata: buildOpenAIChatCompletionRequestMetadata,
      callProvider: ({ candidate, providerApiKey, request }) => {
        const adapter = candidate.providerKey === "openrouter" ? openRouterAdapter : genericAdapter;
        return adapter.chatCompletion({
          request,
          target: {
            apiKey: providerApiKey.apiKey,
            baseUrl: candidate.baseUrl,
            modelId: candidate.modelId,
          },
        });
      },
      normalize: normalizeOpenAIChatCompletionRequest,
      planCandidates: (candidates) => ({
        noneSupportedError: () =>
          new GatewayPipelineError(
            "provider_protocol_unsupported",
            "Chat completions cannot use subscription providers.",
          ),
        supported: candidates.filter(
          (candidate) => !isSubscriptionProviderKey(candidate.providerKey),
        ),
      }),
    },
  });
}

function invalidChatRequest(requestId: string): GatewayChatCompletionRequestFailure {
  return {
    body: createGatewayErrorBody("invalid_chat_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function readOpenAIChatMessage(value: unknown): NormalizedOpenAIChatMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const role = value.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }

  const content = readOpenAIChatMessageContent(value.content);
  const toolCalls = readOptionalObjectArray(value.tool_calls);
  if (toolCalls === null) {
    return null;
  }
  if (role === "assistant" && !content && (!toolCalls || toolCalls.length === 0)) {
    return null;
  }
  if (role !== "assistant" && !content) {
    return null;
  }
  if (role === "tool" && typeof value.tool_call_id !== "string") {
    return null;
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    return null;
  }

  return omitUndefined({
    content: content ?? null,
    name: value.name,
    role,
    tool_call_id: role === "tool" ? value.tool_call_id : undefined,
    tool_calls: toolCalls,
  }) as NormalizedOpenAIChatMessage;
}

function readOpenAIChatMessageContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const textParts = value.map(readOpenAIChatTextContentPart);
  if (textParts.some((part) => part === null)) {
    return null;
  }
  const text = textParts.join("\n").trim();
  return text || null;
}

function readOpenAIChatTextContentPart(value: unknown): string | null {
  if (!isRecord(value) || typeof value.text !== "string") {
    return null;
  }
  if (value.type !== "text" && value.type !== "input_text" && value.type !== "output_text") {
    return null;
  }
  return value.text;
}

function readOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, maxChatCompletionOutputTokens);
}

function readOptionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readOptionalObjectArray(value: unknown): Record<string, unknown>[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    return null;
  }
  return value as Record<string, unknown>[];
}

function readChatPassthroughParameters(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const passthrough: Record<string, unknown> = {};
  for (const key of chatPassthroughParameterKeys) {
    if (body[key] !== undefined) {
      passthrough[key] = body[key];
    }
  }
  return Object.keys(passthrough).length > 0 ? passthrough : undefined;
}

function readOptionalOpenAIToolChoice(
  value: unknown,
): string | Record<string, unknown> | null | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (typeof value === "string") {
    const mode = value.trim();
    return mode === "auto" || mode === "none" || mode === "required" ? mode : null;
  }
  if (isRecord(value)) {
    return value;
  }
  return null;
}
