import type { NormalizedAnthropicMessagesRequest } from "@llmingress/provider/anthropic";
import type {
  NormalizedOpenAIChatRequest,
  NormalizedOpenAIResponsesRequest,
} from "@llmingress/provider/openai";
import { gatewayDebugRequestMetadata } from "./gateway-env.ts";

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
  const messageTextParts = input.request.messages.flatMap((message) =>
    readOpenAIChatMessageContentTextParts(message.content),
  );

  return {
    estimatedInputTokens: estimateTextTokens([...messageTextParts, ...toolTextParts]),
    estimatedOutputTokens: input.request.maxOutputTokens ?? 1024,
    messageCount: input.request.messages.length,
    model: input.model,
    protocol: "chat_completions",
    stream: input.request.stream ?? false,
    usesTools:
      toolTextParts.length > 0 ||
      input.request.messages.some(
        (message) => message.role === "tool" || (message.tool_calls?.length ?? 0) > 0,
      ),
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
      : input.request.input.flatMap(readResponsesInputItemTextParts);
  const messageCount = typeof input.request.input === "string" ? 1 : input.request.input.length;
  const toolTextParts = readToolTextParts(input.rawBody);

  return {
    estimatedInputTokens: estimateTextTokens([...inputTextParts, ...toolTextParts]),
    estimatedOutputTokens: input.request.maxOutputTokens ?? 1024,
    messageCount,
    model: input.model,
    protocol: "responses",
    stream: input.request.stream ?? false,
    usesTools:
      toolTextParts.length > 0 ||
      (Array.isArray(input.request.input) && input.request.input.some(isResponsesToolInputItem)),
  };
}

export function buildAnthropicMessagesRequestMetadata(input: {
  model: string;
  rawBody: unknown;
  request: NormalizedAnthropicMessagesRequest;
}): GatewayRequestMetadata {
  const messageTextParts = [
    ...(input.request.system ? readAnthropicMessageContentTextParts(input.request.system) : []),
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
  return gatewayDebugRequestMetadata(env);
}

export function serializeGatewayRequestMetadata(metadata: GatewayRequestMetadata): string {
  return JSON.stringify(metadata);
}

export function estimateTextTokens(parts: readonly string[]): number {
  const text = parts.filter((part) => part.trim()).join("\n");
  let cjkCount = 0;
  let otherCount = 0;
  for (const character of text) {
    if (isCjkCharacter(character)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return Math.max(1, cjkCount + Math.ceil(otherCount / 4));
}

function isCjkCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }

  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xffef)
  );
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

function readResponsesInputItemTextParts(item: unknown): string[] {
  if (!isRecord(item)) {
    return [];
  }
  const parts: string[] = [];
  if (typeof item.content === "string") {
    parts.push(item.content);
  }
  if (Array.isArray(item.content)) {
    parts.push(...item.content.flatMap(readResponsesContentTextParts));
  }
  if (typeof item.output === "string") {
    parts.push(item.output);
  }
  if (typeof item.arguments === "string") {
    parts.push(item.arguments);
  }
  return parts;
}

function readResponsesContentTextParts(item: unknown): string[] {
  if (!isRecord(item)) {
    return [];
  }
  const parts: string[] = [];
  if (typeof item.text === "string") {
    parts.push(item.text);
  }
  if (typeof item.content === "string") {
    parts.push(item.content);
  }
  return parts;
}

function readOpenAIChatMessageContentTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (!isRecord(part)) {
      return [];
    }
    const parts: string[] = [];
    if (typeof part.text === "string") {
      parts.push(part.text);
    }
    if (typeof part.content === "string") {
      parts.push(part.content);
    }
    return parts;
  });
}

function isResponsesToolInputItem(item: unknown): boolean {
  if (!isRecord(item) || typeof item.type !== "string") {
    return false;
  }
  return item.type === "function_call" || item.type === "function_call_output";
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
