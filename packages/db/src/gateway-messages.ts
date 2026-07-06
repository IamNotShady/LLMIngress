import {
  type AnthropicAdapterSuccess,
  type AnthropicContentBlock,
  type AnthropicMessageContent,
  type AnthropicProviderAdapter,
  createAnthropicProviderAdapter,
  type NormalizedAnthropicMessage,
  type NormalizedAnthropicMessagesRequest,
} from "@llmingress/provider/anthropic";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import { createClaudeCodeProviderAdapter } from "@llmingress/provider/subscription-adapters";
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
import { buildAnthropicMessagesRequestMetadata } from "./gateway-request-metadata.ts";
import { isRecord, omitUndefined } from "./gateway-runtime-helpers.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayAnthropicMessagesResponse = GatewayProtocolResponse;

export type GatewayAnthropicMessagesRequestSuccess = {
  ok: true;
  request: NormalizedAnthropicMessagesRequest;
};

export type GatewayAnthropicMessagesRequestFailure = {
  body: GatewayErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayAnthropicMessagesRequestResult =
  | GatewayAnthropicMessagesRequestFailure
  | GatewayAnthropicMessagesRequestSuccess;

const maxMessagesOutputTokens = 16_384;

export function normalizeAnthropicMessagesRequest(
  body: unknown,
  requestId: string,
): GatewayAnthropicMessagesRequestResult {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidMessagesRequest(requestId);
  }

  const maxOutputTokens = readRequiredPositiveInteger(body.max_tokens);
  if (maxOutputTokens === null) {
    return invalidMessagesRequest(requestId);
  }

  const messages = body.messages.map(readAnthropicMessage);
  if (messages.some((message) => !message)) {
    return invalidMessagesRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidMessagesRequest(requestId);
  }
  const topP = readOptionalFiniteNumber(body.top_p);
  if (topP === null) {
    return invalidMessagesRequest(requestId);
  }
  const topK = readOptionalPositiveInteger(body.top_k);
  if (topK === null) {
    return invalidMessagesRequest(requestId);
  }
  const stopSequences = readOptionalNonEmptyStringArray(body.stop_sequences);
  if (stopSequences === null) {
    return invalidMessagesRequest(requestId);
  }
  const metadata = readOptionalRecord(body.metadata);
  if (metadata === null) {
    return invalidMessagesRequest(requestId);
  }
  const thinking = readOptionalRecord(body.thinking);
  if (thinking === null) {
    return invalidMessagesRequest(requestId);
  }
  const serviceTier = readOptionalNonEmptyString(body.service_tier);
  if (serviceTier === null) {
    return invalidMessagesRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidMessagesRequest(requestId);
  }
  const system = readOptionalSystemPrompt(body.system);
  if (system === null) {
    return invalidMessagesRequest(requestId);
  }
  const tools = readOptionalObjectArray(body.tools);
  if (tools === null) {
    return invalidMessagesRequest(requestId);
  }
  const toolChoice = readOptionalToolChoice(body.tool_choice);
  if (toolChoice === null) {
    return invalidMessagesRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages: messages as NormalizedAnthropicMessage[],
      metadata,
      passthrough: readPassthroughParameters(body, [
        "max_tokens",
        "messages",
        "metadata",
        "model",
        "service_tier",
        "stop_sequences",
        "stream",
        "system",
        "temperature",
        "thinking",
        "tool_choice",
        "tools",
        "top_k",
        "top_p",
      ]),
      serviceTier,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      stopSequences,
      system,
      temperature,
      thinking,
      toolChoice,
      tools,
      topK,
      topP,
    }),
  };
}

export async function executeGatewayAnthropicMessages(input: {
  agentId: string;
  adapter?: AnthropicProviderAdapter;
  databaseUrl?: string;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayAnthropicMessagesResponse> {
  const genericAdapter = input.adapter ?? createAnthropicProviderAdapter();
  const claudeCodeAdapter = input.adapter ? null : createClaudeCodeProviderAdapter();

  return executeGatewayProtocolRequest<NormalizedAnthropicMessagesRequest, AnthropicAdapterSuccess>(
    {
      ...input,
      protocol: "messages",
      spec: {
        buildRequestMetadata: buildAnthropicMessagesRequestMetadata,
        callProvider: ({ candidate, providerApiKey, request }) => {
          const adapter =
            candidate.providerKey === "claude_code" && claudeCodeAdapter
              ? claudeCodeAdapter
              : genericAdapter;
          return adapter.messages({
            request,
            target: {
              apiKey: providerApiKey.apiKey,
              baseUrl: candidate.baseUrl,
              modelId: candidate.modelId,
            },
          });
        },
        normalize: normalizeAnthropicMessagesRequest,
        planCandidates: (candidates) => ({
          noneSupportedError: () =>
            new GatewayPipelineError(
              "provider_protocol_unsupported",
              "Anthropic messages cannot use unsupported subscription providers.",
            ),
          supported: candidates.filter(
            (candidate) =>
              !isSubscriptionProviderKey(candidate.providerKey) ||
              candidate.providerKey === "claude_code",
          ),
        }),
      },
    },
  );
}

function readAnthropicMessage(value: unknown): NormalizedAnthropicMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.role !== "user" && value.role !== "assistant") {
    return null;
  }
  const content = readAnthropicMessageContent(value.content);
  if (!content) {
    return null;
  }

  return {
    ...value,
    content,
    role: value.role,
  };
}

function readAnthropicMessageContent(value: unknown): AnthropicMessageContent | null {
  if (typeof value === "string") {
    return value.trim() ? value : null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const blocks = value.map(readAnthropicContentBlock);
  if (blocks.some((block) => !block)) {
    return null;
  }
  return blocks as AnthropicContentBlock[];
}

function readAnthropicContentBlock(value: unknown): AnthropicContentBlock | null {
  if (!isRecord(value) || typeof value.type !== "string" || !value.type.trim()) {
    return null;
  }
  return value as AnthropicContentBlock;
}

function readRequiredPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, maxMessagesOutputTokens);
}

function readOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredPositiveInteger(value);
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

function readOptionalSystemPrompt(value: unknown): AnthropicMessageContent | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    if (value.some((block) => !isRecord(block) || typeof block.type !== "string")) {
      return null;
    }
    return value as AnthropicContentBlock[];
  }
  return null;
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

function readOptionalRecord(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  return value;
}

function readOptionalNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value;
}

function readOptionalNonEmptyStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return null;
  }
  return value;
}

function readOptionalToolChoice(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string" || !value.type.trim()) {
    return null;
  }
  return value;
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

function invalidMessagesRequest(requestId: string): GatewayAnthropicMessagesRequestFailure {
  return {
    body: createGatewayErrorBody("invalid_messages_request", requestId),
    ok: false,
    statusCode: 400,
  };
}
