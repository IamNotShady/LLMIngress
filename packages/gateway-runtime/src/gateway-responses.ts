import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIResponsesInputItem,
  type NormalizedOpenAIResponsesInputMessage,
  type NormalizedOpenAIResponsesRequest,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { createCodexSubscriptionAdapter } from "@llmingress/provider/subscription-adapters";
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
import { buildOpenAIResponsesRequestMetadata } from "./gateway-request-metadata.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayResponsesResponse = GatewayProtocolResponse;

export type GatewayResponsesRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIResponsesRequest;
};

export type GatewayResponsesRequestFailure = {
  body: GatewayErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayResponsesRequestResult =
  | GatewayResponsesRequestFailure
  | GatewayResponsesRequestSuccess;

export function normalizeOpenAIResponsesRequest(
  body: unknown,
  requestId: string,
): GatewayResponsesRequestResult {
  if (!isRecord(body)) {
    return invalidResponsesRequest(requestId);
  }

  const input = readResponsesInput(body.input);
  if (input === null) {
    return invalidResponsesRequest(requestId);
  }

  const instructions = readOptionalStringOrNull(body.instructions);

  const maxOutputTokens = readOptionalPositiveInteger(body.max_output_tokens);

  const temperature = readOptionalFiniteNumber(body.temperature);

  const tools = readOptionalObjectArray(body.tools);
  const toolChoice = readOptionalOpenAIToolChoice(body.tool_choice);

  return {
    ok: true,
    request: omitUndefined({
      input,
      instructions: instructions === false ? undefined : instructions,
      maxOutputTokens: maxOutputTokens === null ? undefined : maxOutputTokens,
      passthrough: readPassthroughParameters(body, ["input", "model"]),
      payload: body,
      parallelToolCalls:
        typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature: temperature === null ? undefined : temperature,
      toolChoice: toolChoice === null ? undefined : toolChoice,
      tools: tools === null ? undefined : tools,
    }),
  };
}

export async function executeGatewayOpenAIResponse(input: {
  agentId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl?: string;
  providerRequestHeaders?: Record<string, string>;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayResponsesResponse> {
  const genericAdapter = input.adapter ?? createOpenAIProviderAdapter();
  const codexAdapter = input.adapter ? null : createCodexSubscriptionAdapter();
  const unsupportedProviders = new Set<string>();

  return executeGatewayProtocolRequest<NormalizedOpenAIResponsesRequest, OpenAIAdapterSuccess>({
    ...input,
    protocol: "responses",
    spec: {
      buildRequestMetadata: buildOpenAIResponsesRequestMetadata,
      callProvider: ({ candidate, providerApiKey, providerRequestHeaders, request }) => {
        const adapter =
          resolveProviderDescriptor(candidate.providerKey).subscriptionAdapter === "codex" &&
          codexAdapter
            ? codexAdapter
            : genericAdapter;
        if (!adapter.response) {
          throw new GatewayPipelineError(
            "provider_protocol_unsupported",
            "OpenAI responses provider adapter is not configured.",
          );
        }
        return adapter.response({
          headers: providerRequestHeaders,
          request,
          target: {
            apiKey: providerApiKey.apiKey,
            baseUrl: candidate.baseUrl,
            modelId: candidate.modelId,
          },
        });
      },
      normalize: normalizeOpenAIResponsesRequest,
      planCandidates: (candidates) => {
        unsupportedProviders.clear();
        const supported = candidates.filter((candidate) => {
          const descriptor = resolveProviderDescriptor(candidate.providerKey);
          if (descriptor.subscription === true && descriptor.subscriptionAdapter !== "codex") {
            unsupportedProviders.add(candidate.providerKey);
            return false;
          }
          return true;
        });
        return {
          noneSupportedError: () =>
            new GatewayPipelineError(
              "provider_protocol_unsupported",
              `Responses API cannot use provider ${Array.from(unsupportedProviders).join(", ")}.`,
            ),
          supported,
        };
      },
    },
  });
}

function readResponsesInput(value: unknown): NormalizedOpenAIResponsesInputItem[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const items = value.map(readResponsesInputItem);
  if (items.some((item) => !item)) {
    return null;
  }
  return items as NormalizedOpenAIResponsesInputItem[];
}

function readResponsesInputItem(value: unknown): NormalizedOpenAIResponsesInputItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "message") {
    return readResponsesInputMessage(value);
  }
  if (typeof value.type === "string" && value.type.trim()) {
    return value;
  }
  return readResponsesInputMessage(value);
}

function readResponsesInputMessage(value: unknown): NormalizedOpenAIResponsesInputMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.role !== "developer" &&
    value.role !== "system" &&
    value.role !== "user" &&
    value.role !== "assistant"
  ) {
    return null;
  }
  const content = readResponsesMessageContent(value.content, value.role);
  if (content === null) {
    return null;
  }

  return value as NormalizedOpenAIResponsesInputMessage;
}

function readResponsesMessageContent(
  value: unknown,
  role: NormalizedOpenAIResponsesInputMessage["role"],
): NormalizedOpenAIResponsesInputMessage["content"] | null {
  if (!Array.isArray(value) || (value.length === 0 && role !== "assistant")) {
    return null;
  }
  if (value.some((part) => !isRecord(part))) {
    return null;
  }
  return value as Record<string, unknown>[];
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

function readOptionalStringOrNull(value: unknown): string | null | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : false;
}

function invalidResponsesRequest(requestId: string): GatewayResponsesRequestFailure {
  return {
    body: createGatewayErrorBody("invalid_responses_request", requestId),
    ok: false,
    statusCode: 400,
  };
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
