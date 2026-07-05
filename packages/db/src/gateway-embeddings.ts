import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIEmbeddingsRequest,
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
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";
import { isRecord, omitUndefined } from "./gateway-runtime-helpers.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayEmbeddingsResponse = GatewayProtocolResponse;

export type GatewayEmbeddingsRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIEmbeddingsRequest;
};

export type GatewayEmbeddingsRequestFailure = {
  body: GatewayErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayEmbeddingsRequestResult =
  | GatewayEmbeddingsRequestFailure
  | GatewayEmbeddingsRequestSuccess;

export function normalizeOpenAIEmbeddingsRequest(
  body: unknown,
  requestId: string,
): GatewayEmbeddingsRequestResult {
  if (!isRecord(body)) {
    return invalidEmbeddingsRequest(requestId);
  }

  const input = readEmbeddingsInput(body.input);
  if (!input) {
    return invalidEmbeddingsRequest(requestId);
  }

  const dimensions = readOptionalPositiveInteger(body.dimensions);
  if (dimensions === null) {
    return invalidEmbeddingsRequest(requestId);
  }

  const encodingFormat = readOptionalEncodingFormat(body.encoding_format);
  if (encodingFormat === null) {
    return invalidEmbeddingsRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      dimensions,
      encodingFormat,
      input,
    }),
  };
}

export function buildOpenAIEmbeddingsRequestMetadata(input: {
  model: string;
  request: NormalizedOpenAIEmbeddingsRequest;
}): GatewayRequestMetadata {
  const inputParts = Array.isArray(input.request.input)
    ? input.request.input
    : [input.request.input];

  return {
    estimatedInputTokens: estimateTextTokens(inputParts),
    estimatedOutputTokens: 0,
    messageCount: inputParts.length,
    model: input.model,
    protocol: "embeddings",
    stream: false,
    usesTools: false,
  };
}

export function createGatewayEmbeddingsProviderAdapter(input: {
  adapter?: OpenAIProviderAdapter;
  fetch?: typeof globalThis.fetch;
  providerKey: string;
}): OpenAIProviderAdapter {
  if (input.adapter) {
    return input.adapter;
  }
  if (input.providerKey === "openrouter") {
    return createOpenRouterProviderAdapter({ fetch: input.fetch });
  }
  return createOpenAIProviderAdapter({ fetch: input.fetch });
}

export async function executeGatewayOpenAIEmbeddings(input: {
  agentId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl?: string;
  masterKeySource?: MasterKeySource;
  requestActivityId?: string;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayEmbeddingsResponse> {
  return executeGatewayProtocolRequest<NormalizedOpenAIEmbeddingsRequest, OpenAIAdapterSuccess>({
    ...input,
    spec: {
      buildRequestMetadata: ({ model, request }) =>
        buildOpenAIEmbeddingsRequestMetadata({ model, request }),
      callProvider: ({ candidate, providerApiKey, request }) => {
        const adapter = createGatewayEmbeddingsProviderAdapter({
          adapter: input.adapter,
          providerKey: candidate.providerKey,
        });
        if (!adapter.embeddings) {
          throw new GatewayPipelineError(
            "provider_protocol_unsupported",
            "OpenAI embeddings provider adapter is not configured.",
          );
        }
        return adapter.embeddings({
          request,
          target: {
            apiKey: providerApiKey.apiKey,
            baseUrl: candidate.baseUrl,
            modelId: candidate.modelId,
          },
        });
      },
      normalize: normalizeOpenAIEmbeddingsRequest,
      planCandidates: (candidates) => ({
        noneSupportedError: () =>
          new GatewayPipelineError(
            "provider_protocol_unsupported",
            "Embeddings cannot use subscription providers.",
          ),
        supported: candidates.filter(
          (candidate) => !isSubscriptionProviderKey(candidate.providerKey),
        ),
      }),
    },
  });
}

function invalidEmbeddingsRequest(requestId: string): GatewayEmbeddingsRequestFailure {
  return {
    body: createGatewayErrorBody("invalid_embeddings_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function readEmbeddingsInput(value: unknown): string | string[] | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    return value;
  }
  return null;
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

function readOptionalEncodingFormat(value: unknown): "base64" | "float" | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "base64" || value === "float" ? value : null;
}

function estimateTextTokens(parts: readonly string[]): number {
  const characterCount = parts.filter((part) => part.trim()).join("\n").length;
  return Math.max(1, Math.ceil(characterCount / 4));
}
