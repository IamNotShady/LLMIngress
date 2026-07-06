import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIResponsesInputMessage,
  type NormalizedOpenAIResponsesRequest,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import { createCodexSubscriptionAdapter } from "@llmingress/provider/subscription-adapters";
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
import { isRecord, omitUndefined } from "./gateway-runtime-helpers.ts";
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

  if (typeof body.previous_response_id === "string" && body.previous_response_id.trim()) {
    return unsupportedStatefulResponses(requestId);
  }
  if (body.store === true) {
    return unsupportedStatefulResponses(requestId);
  }
  if (body.store !== undefined && typeof body.store !== "boolean") {
    return invalidResponsesRequest(requestId);
  }

  const input = readResponsesInput(body.input);
  if (!input) {
    return invalidResponsesRequest(requestId);
  }

  const instructions = readOptionalNonEmptyString(body.instructions);
  if (instructions === null) {
    return invalidResponsesRequest(requestId);
  }

  const maxOutputTokens = readOptionalPositiveInteger(body.max_output_tokens);
  if (maxOutputTokens === null) {
    return invalidResponsesRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidResponsesRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidResponsesRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      input,
      instructions,
      maxOutputTokens,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
    }),
  };
}

export async function executeGatewayOpenAIResponse(input: {
  agentId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl?: string;
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
      callProvider: ({ candidate, providerApiKey, request }) => {
        const adapter =
          candidate.providerKey === "openai_codex" && codexAdapter ? codexAdapter : genericAdapter;
        if (!adapter.response) {
          throw new GatewayPipelineError(
            "provider_protocol_unsupported",
            "OpenAI responses provider adapter is not configured.",
          );
        }
        return adapter.response({
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
          if (
            isSubscriptionProviderKey(candidate.providerKey) &&
            candidate.providerKey !== "openai_codex"
          ) {
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

function readResponsesInput(
  value: unknown,
): string | NormalizedOpenAIResponsesInputMessage[] | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const messages = value.map(readResponsesInputMessage);
  if (messages.some((message) => !message)) {
    return null;
  }
  return messages as NormalizedOpenAIResponsesInputMessage[];
}

function readResponsesInputMessage(value: unknown): NormalizedOpenAIResponsesInputMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const content = readResponsesMessageContent(value.content);
  if (!content) {
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

  return {
    content,
    role: value.role,
  };
}

function readResponsesMessageContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const textParts = value.map(readResponsesTextContentPart);
  if (textParts.some((part) => part === null)) {
    return null;
  }
  const text = textParts.join("\n").trim();
  return text || null;
}

function readResponsesTextContentPart(value: unknown): string | null {
  if (!isRecord(value) || typeof value.text !== "string") {
    return null;
  }
  if (value.type !== "input_text" && value.type !== "output_text") {
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

function readOptionalNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function invalidResponsesRequest(requestId: string): GatewayResponsesRequestFailure {
  return {
    body: createGatewayErrorBody("invalid_responses_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function unsupportedStatefulResponses(requestId: string): GatewayResponsesRequestFailure {
  return {
    body: createGatewayErrorBody("unsupported_stateful_responses", requestId),
    ok: false,
    statusCode: 400,
  };
}
