import type { MasterKeySource } from "@llmingress/security/master-key";
import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
import {
  attachGatewayProviderCredentials,
  readGatewayMasterKeySource,
} from "./chat-completions.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import { mapGatewayErrorStatus } from "./error-mapping.js";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIEmbeddingsRequest,
  type OpenAIProviderAdapter,
} from "./provider-adapters/openai.js";
import { createOpenRouterProviderAdapter } from "./provider-adapters/openrouter.js";
import type { GatewayRequestMetadata } from "./request-metadata.js";
import { selectRouteCandidate } from "./route-engine.js";
import {
  type GatewayUsageCostDetails,
  readGatewayProviderTokenUsage,
  selectGatewayBaselineCandidate,
} from "./usage-recorder.js";
import type { GatewayVirtualModel } from "./virtual-model-access.js";

export type GatewayEmbeddingsErrorCode =
  | "invalid_embeddings_request"
  | "provider_credentials_missing"
  | "provider_request_failed"
  | "route_not_found";

export type GatewayEmbeddingsErrorBody = {
  error: {
    code: GatewayEmbeddingsErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayEmbeddingsResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayEmbeddingsRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIEmbeddingsRequest;
};

export type GatewayEmbeddingsRequestFailure = {
  body: GatewayEmbeddingsErrorBody;
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
  adapter?: OpenAIProviderAdapter;
  databaseUrl: string;
  masterKeySource?: MasterKeySource;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayEmbeddingsResponse> {
  const normalized = normalizeOpenAIEmbeddingsRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return {
      body: normalized.body,
      statusCode: normalized.statusCode,
    };
  }

  const requestMetadata = buildOpenAIEmbeddingsRequestMetadata({
    model: input.virtualModel.name,
    request: normalized.request,
  });

  let activity: GatewayRequestActivityRoute | undefined;
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      snapshot: input.snapshot,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const selectedCandidate = requireSelectedCandidate(routePolicy, routeDecision.providerModelId);
    activity = buildRequestActivityRoute({
      candidate: selectedCandidate,
      routeDecision,
    });

    const [selected] = await attachGatewayProviderCredentials({
      candidates: [selectedCandidate],
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource ?? readGatewayMasterKeySource(),
    });
    if (!selected) {
      throw new Error("Provider credentials are missing for the selected route.");
    }

    const adapter = createGatewayEmbeddingsProviderAdapter({
      adapter: input.adapter,
      providerKey: selected.providerKey,
    });
    if (!adapter.embeddings) {
      throw new Error("OpenAI embeddings provider adapter is not configured.");
    }
    const result = await adapter.embeddings({
      request: normalized.request,
      target: {
        apiKey: selected.apiKey,
        baseUrl: selected.baseUrl,
        modelId: selected.modelId,
      },
    });
    if (!result.ok) {
      throw new Error(result.errorMessage);
    }

    return {
      activity,
      body: result.body,
      requestMetadata,
      statusCode: result.statusCode,
      usageCost: {
        actualPrice: selected.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: requestMetadata.estimatedInputTokens,
        estimatedOutputTokens: 0,
        providerUsage: readGatewayProviderTokenUsage(result.body),
        providerModelId: selected.providerModelId,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyEmbeddingsError(message);
    return {
      activity,
      body: createGatewayEmbeddingsErrorBody(code, input.requestId),
      requestMetadata,
      statusCode: mapGatewayErrorStatus(code),
    };
  }
}

function buildRequestActivityRoute(input: {
  candidate: GatewayRouteCandidateSnapshot;
  routeDecision: ReturnType<typeof selectRouteCandidate>;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: [],
    providerId: input.candidate.providerId,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routeDecision.routePolicyId,
    routeReason: input.routeDecision.routeReason,
  };
}

function requireRoutePolicy(
  snapshot: GatewayConfigSnapshot,
  routePolicyId: string,
): GatewayRoutePolicySnapshot {
  const routePolicy = snapshot.routePolicies.find((candidate) => candidate.id === routePolicyId);
  if (!routePolicy) {
    throw new Error(`Route policy ${routePolicyId} was not found.`);
  }
  return routePolicy;
}

function requireSelectedCandidate(
  routePolicy: GatewayRoutePolicySnapshot,
  providerModelId: string,
): GatewayRouteCandidateSnapshot {
  const candidate = routePolicy.candidates.find(
    (routeCandidate) => routeCandidate.providerModelId === providerModelId,
  );
  if (!candidate) {
    throw new Error(`Route policy ${routePolicy.id} selected candidate was not found.`);
  }
  return candidate;
}

function invalidEmbeddingsRequest(requestId: string): GatewayEmbeddingsRequestFailure {
  return {
    body: createGatewayEmbeddingsErrorBody("invalid_embeddings_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function createGatewayEmbeddingsErrorBody(
  code: GatewayEmbeddingsErrorCode,
  requestId: string,
): GatewayEmbeddingsErrorBody {
  return {
    error: {
      code,
      message: embeddingsErrorMessage(code),
    },
    requestId,
  };
}

function embeddingsErrorMessage(code: GatewayEmbeddingsErrorCode): string {
  if (code === "invalid_embeddings_request") {
    return "Embeddings request must include non-empty input text.";
  }
  if (code === "route_not_found") {
    return "No route policy is available for the selected Virtual Model.";
  }
  if (code === "provider_credentials_missing") {
    return "Provider credentials are not configured for the selected route.";
  }
  return "Provider request failed.";
}

function classifyEmbeddingsError(message: string): GatewayEmbeddingsErrorCode {
  if (message.includes("No route policy") || message.includes("Route policy")) {
    return "route_not_found";
  }
  if (message.includes("Provider credentials") || message.includes("Provider base URL")) {
    return "provider_credentials_missing";
  }
  return "provider_request_failed";
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

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
