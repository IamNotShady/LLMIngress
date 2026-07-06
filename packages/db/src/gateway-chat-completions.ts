import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIChatMessage,
  type NormalizedOpenAIChatRequest,
  type OpenAIAdapterSuccess,
  type OpenAIChatMaxOutputTokenField,
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
  const maxOutputTokenField = readMaxOutputTokenField(body);

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

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      maxOutputTokenField,
      messages: messages as NormalizedOpenAIChatMessage[],
      payload: body,
      passthrough: readChatPassthroughParameters(body),
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
  if (
    role !== "developer" &&
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool" &&
    role !== "function"
  ) {
    return null;
  }

  const hasContent = isOpenAIChatMessageContent(value.content);
  const toolCalls = readOptionalObjectArray(value.tool_calls);
  if (toolCalls === null) {
    return null;
  }
  if (
    role === "assistant" &&
    !hasContent &&
    (!toolCalls || toolCalls.length === 0) &&
    !isRecord(value.function_call) &&
    !isRecord(value.audio)
  ) {
    return null;
  }
  if (role !== "assistant" && !hasContent) {
    return null;
  }
  if (role === "tool" && typeof value.tool_call_id !== "string") {
    return null;
  }
  if (role === "function" && typeof value.name !== "string") {
    return null;
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    return null;
  }

  return value as NormalizedOpenAIChatMessage;
}

function isOpenAIChatMessageContent(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (value === null || value === undefined) {
    return false;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every(isRecord);
}

function readOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
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

function readMaxOutputTokenField(
  body: Record<string, unknown>,
): OpenAIChatMaxOutputTokenField | undefined {
  if (body.max_completion_tokens !== undefined) {
    return "max_completion_tokens";
  }
  if (body.max_tokens !== undefined) {
    return "max_tokens";
  }
  return undefined;
}

function readPassthroughParameters(
  body: Record<string, unknown>,
  omittedKeys: readonly string[],
): Record<string, unknown> | undefined {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!omittedKeys.includes(key) && value !== undefined) {
      passthrough[key] = value;
    }
  }
  return Object.keys(passthrough).length > 0 ? passthrough : undefined;
}

function readChatPassthroughParameters(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return readPassthroughParameters(body, ["messages", "model"]);
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
