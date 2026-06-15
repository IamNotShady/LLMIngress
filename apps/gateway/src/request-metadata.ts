import type { NormalizedAnthropicMessagesRequest } from "./provider-adapters/anthropic.js";
import type {
  NormalizedOpenAIChatRequest,
  NormalizedOpenAIResponsesRequest,
} from "./provider-adapters/openai.js";

export type GatewayRequestProtocol = "chat_completions" | "embeddings" | "messages" | "responses";

export type GatewayRequestMetadata = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  messageCount: number;
  model: string;
  protocol: GatewayRequestProtocol;
  stream: boolean;
  usesTools: boolean;
};

export const gatewayRequestMetadataHeader = "x-llmingress-request-metadata";

export function buildOpenAIChatCompletionRequestMetadata(input: {
  model: string;
  rawBody: unknown;
  request: NormalizedOpenAIChatRequest;
}): GatewayRequestMetadata {
  const toolTextParts = readToolTextParts(input.rawBody);
  const messageTextParts = input.request.messages.map((message) => message.content);

  return {
    estimatedInputTokens: estimateTextTokens([...messageTextParts, ...toolTextParts]),
    estimatedOutputTokens: input.request.maxOutputTokens ?? 1024,
    messageCount: input.request.messages.length,
    model: input.model,
    protocol: "chat_completions",
    stream: input.request.stream ?? false,
    usesTools:
      toolTextParts.length > 0 || input.request.messages.some((message) => message.role === "tool"),
  };
}

export function buildOpenAIResponsesRequestMetadata(input: {
  model: string;
  rawBody: unknown;
  request: NormalizedOpenAIResponsesRequest;
}): GatewayRequestMetadata {
  const inputTextParts =
    typeof input.request.input === "string"
      ? [input.request.input]
      : input.request.input.map((message) => message.content);
  const messageCount = typeof input.request.input === "string" ? 1 : input.request.input.length;
  const toolTextParts = readToolTextParts(input.rawBody);

  return {
    estimatedInputTokens: estimateTextTokens([...inputTextParts, ...toolTextParts]),
    estimatedOutputTokens: input.request.maxOutputTokens ?? 1024,
    messageCount,
    model: input.model,
    protocol: "responses",
    stream: input.request.stream ?? false,
    usesTools: toolTextParts.length > 0,
  };
}

export function buildAnthropicMessagesRequestMetadata(input: {
  model: string;
  rawBody: unknown;
  request: NormalizedAnthropicMessagesRequest;
}): GatewayRequestMetadata {
  const messageTextParts = [
    input.request.system ?? "",
    ...input.request.messages.flatMap((message) =>
      readAnthropicMessageContentTextParts(message.content),
    ),
  ];
  const toolTextParts = readToolTextParts(input.rawBody);

  return {
    estimatedInputTokens: estimateTextTokens([...messageTextParts, ...toolTextParts]),
    estimatedOutputTokens: input.request.maxOutputTokens,
    messageCount: input.request.messages.length,
    model: input.model,
    protocol: "messages",
    stream: input.request.stream ?? false,
    usesTools: toolTextParts.length > 0,
  };
}

export function shouldExposeGatewayRequestMetadata(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GATEWAY_DEBUG_REQUEST_METADATA === "true";
}

export function serializeGatewayRequestMetadata(metadata: GatewayRequestMetadata): string {
  return JSON.stringify(metadata);
}

function estimateTextTokens(parts: readonly string[]): number {
  const characterCount = parts.filter((part) => part.trim()).join("\n").length;
  return Math.max(1, Math.ceil(characterCount / 4));
}

function readAnthropicMessageContentTextParts(
  content: NormalizedAnthropicMessagesRequest["messages"][number]["content"],
): string[] {
  if (typeof content === "string") {
    return [content];
  }

  return content.flatMap((block) => {
    const parts: string[] = [];
    if (typeof block.text === "string") {
      parts.push(block.text);
    }
    if (typeof block.content === "string") {
      parts.push(block.content);
    }
    return parts;
  });
}

function readToolTextParts(rawBody: unknown): string[] {
  if (!isRecord(rawBody)) {
    return [];
  }

  const parts: string[] = [];
  if (Array.isArray(rawBody.tools) && rawBody.tools.length > 0) {
    parts.push(safeStringify(rawBody.tools));
  }
  if (Array.isArray(rawBody.functions) && rawBody.functions.length > 0) {
    parts.push(safeStringify(rawBody.functions));
  }
  if (
    rawBody.tool_choice !== undefined &&
    rawBody.tool_choice !== "none" &&
    rawBody.tool_choice !== false
  ) {
    parts.push(safeStringify(rawBody.tool_choice));
  }

  return parts.filter((part) => part.trim());
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
