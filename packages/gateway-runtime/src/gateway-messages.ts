import {
  type AnthropicAdapterSuccess,
  type AnthropicContentBlock,
  type AnthropicMessageContent,
  type AnthropicProviderAdapter,
  createAnthropicProviderAdapter,
  type NormalizedAnthropicMessage,
  type NormalizedAnthropicMessagesRequest,
} from "@llmingress/provider/anthropic";
import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import {
  createClaudeCodeProviderAdapter,
  createMiniMaxProviderAdapter,
} from "@llmingress/provider/subscription-adapters";
import { isRecord, omitUndefined } from "@llmingress/util";
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

export function normalizeAnthropicMessagesRequest(
  body: unknown,
  requestId: string,
): GatewayAnthropicMessagesRequestResult {
  if (!isRecord(body)) {
    return invalidMessagesRequest(requestId);
  }

  const maxOutputTokens = readRequiredPositiveInteger(body.max_tokens) ?? 1024;

  const messages = readAnthropicMessages(body.messages);

  const temperature = readOptionalFiniteNumber(body.temperature);
  const topP = readOptionalFiniteNumber(body.top_p);
  const topK = readOptionalPositiveInteger(body.top_k);
  const stopSequences = readOptionalNonEmptyStringArray(body.stop_sequences);
  const metadata = readOptionalRecord(body.metadata);
  const thinking = readOptionalRecord(body.thinking);
  const serviceTier = readOptionalNonEmptyString(body.service_tier);

  const system = readOptionalSystemPrompt(body.system);
  const tools = readOptionalObjectArray(body.tools);
  const toolChoice = readOptionalToolChoice(body.tool_choice);

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages,
      metadata: metadata === null ? undefined : metadata,
      payload: body,
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
      serviceTier: serviceTier === null ? undefined : serviceTier,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      stopSequences: stopSequences === null ? undefined : stopSequences,
      system: system === null ? undefined : system,
      temperature: temperature === null ? undefined : temperature,
      thinking: thinking === null ? undefined : thinking,
      toolChoice: toolChoice === null ? undefined : toolChoice,
      tools: tools === null ? undefined : tools,
      topK: topK === null ? undefined : topK,
      topP: topP === null ? undefined : topP,
    }),
  };
}

export async function executeGatewayAnthropicMessages(input: {
  apiKeyId: string;
  adapter?: AnthropicProviderAdapter;
  databaseUrl?: string;
  limitsEnabled?: boolean;
  providerRequestHeaders?: Record<string, string>;
  requestBody: unknown;
  requestedTag?: string;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayAnthropicMessagesResponse> {
  const genericAdapter = input.adapter ?? createAnthropicProviderAdapter();
  const claudeCodeAdapter = input.adapter ? null : createClaudeCodeProviderAdapter();
  const minimaxAdapter = input.adapter ? null : createMiniMaxProviderAdapter();

  return executeGatewayProtocolRequest<NormalizedAnthropicMessagesRequest, AnthropicAdapterSuccess>(
    {
      ...input,
      protocol: "messages",
      spec: {
        buildRequestMetadata: buildAnthropicMessagesRequestMetadata,
        callProvider: ({ candidate, providerApiKey, providerRequestHeaders, request }) => {
          const subscriptionAdapter = resolveProviderDescriptor(
            candidate.providerKey,
          ).subscriptionAdapter;
          const adapter =
            subscriptionAdapter === "claude_code" && claudeCodeAdapter
              ? claudeCodeAdapter
              : subscriptionAdapter === "minimax_anthropic" && minimaxAdapter
                ? minimaxAdapter
                : genericAdapter;
          return adapter.messages({
            headers: providerRequestHeaders,
            request,
            target: {
              apiKey: providerApiKey.apiKey,
              // Per-token resource_url overrides the provider base and follows
              // the key across fallback rotation.
              baseUrl: providerApiKey.baseUrl ?? candidate.baseUrl,
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
          supported: candidates.filter((candidate) => {
            const descriptor = resolveProviderDescriptor(candidate.providerKey);
            return (
              descriptor.subscription !== true ||
              descriptor.subscriptionAdapter === "claude_code" ||
              descriptor.subscriptionAdapter === "minimax_anthropic"
            );
          }),
        }),
      },
    },
  );
}

function readAnthropicMessages(value: unknown): NormalizedAnthropicMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((message) => {
    const normalized = readAnthropicMessage(message);
    return normalized ? [normalized] : [];
  });
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
  return value;
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
