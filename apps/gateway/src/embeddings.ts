import type { MasterKeySource } from "@llmingress/security/master-key";
import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
import {
  attachGatewayProviderCredentials,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./chat-completions.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import { mapGatewayErrorStatus } from "./error-mapping.js";
import {
  buildFallbackAttemptCandidates,
  buildFallbackFailedAttempt,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  readFallbackProviderApiKeys,
  recordFailedAttemptInDatabase,
  recordSucceededAttemptInDatabase,
} from "./fallback-chain.js";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIEmbeddingsRequest,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "./provider-adapters/openai.js";
import { createOpenRouterProviderAdapter } from "./provider-adapters/openrouter.js";
import type { GatewayRequestMetadata } from "./request-metadata.js";
import { selectRouteCandidate } from "./route-engine.js";
import { recordGatewayProviderTrace } from "./tracing.js";
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
  requestActivityId?: string;
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
  const fallbackAttempts: FallbackFailedAttempt[] = [];
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      snapshot: input.snapshot,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const attemptCandidates = buildFallbackAttemptCandidates({
      routePolicy,
      selectedProviderModelId: routeDecision.providerModelId,
    });
    const selectedCandidate = requireFirstCandidate(attemptCandidates);
    activity = buildRequestActivityRoute({
      candidate: selectedCandidate,
      fallbackAttempts,
      routeDecision,
    });

    const candidates = await attachGatewayProviderCredentials({
      candidates: attemptCandidates,
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource ?? readGatewayMasterKeySource(),
    });
    const success = await executeEmbeddingsFallback({
      adapter: input.adapter,
      candidates,
      databaseUrl: input.databaseUrl,
      fallbackAttempts,
      request: normalized.request,
      requestActivityId: input.requestActivityId,
      requestId: input.requestId,
    });
    if (!success) {
      throw new Error("Provider request failed.");
    }
    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: success.candidate.providerApiKeyId,
    });
    activity = buildRequestActivityRoute({
      candidate: success.candidate,
      fallbackAttempts,
      routeDecision,
    });

    return {
      activity,
      body: success.result.body,
      requestMetadata,
      statusCode: success.result.statusCode,
      usageCost: {
        actualPrice: success.candidate.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: requestMetadata.estimatedInputTokens,
        estimatedOutputTokens: 0,
        providerUsage: readGatewayProviderTokenUsage(success.result.body),
        providerModelId: success.candidate.providerModelId,
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

async function executeEmbeddingsFallback(input: {
  adapter?: OpenAIProviderAdapter;
  candidates: readonly FallbackChainCandidate[];
  databaseUrl: string;
  fallbackAttempts: FallbackFailedAttempt[];
  request: NormalizedOpenAIEmbeddingsRequest;
  requestActivityId?: string;
  requestId: string;
}): Promise<
  | {
      candidate: FallbackChainCandidate & {
        providerApiKeyId?: string;
        providerApiKeyPrefix?: string;
      };
      result: OpenAIAdapterSuccess;
    }
  | undefined
> {
  let attemptOrder = 0;
  for (const candidate of input.candidates) {
    const adapter = createGatewayEmbeddingsProviderAdapter({
      adapter: input.adapter,
      providerKey: candidate.providerKey,
    });
    if (!adapter.embeddings) {
      throw new Error("OpenAI embeddings provider adapter is not configured.");
    }

    for (const providerApiKey of readFallbackProviderApiKeys(candidate)) {
      attemptOrder += 1;
      const providerStartedAt = new Date();
      const result = await adapter.embeddings({
        request: input.request,
        target: {
          apiKey: providerApiKey.apiKey,
          baseUrl: candidate.baseUrl,
          modelId: candidate.modelId,
        },
      });
      await recordGatewayProviderTrace({
        errorCode: result.ok ? null : result.errorCode,
        modelId: candidate.modelId,
        providerKey: candidate.providerKey,
        requestId: input.requestId,
        startedAt: providerStartedAt,
        status: result.ok ? "succeeded" : "failed",
      });

      if (result.ok) {
        await recordSucceededAttemptInDatabase(input, {
          attemptOrder,
          ...(providerApiKey.providerApiKeyId
            ? { providerApiKeyId: providerApiKey.providerApiKeyId }
            : {}),
          ...(providerApiKey.keyPrefix ? { providerApiKeyPrefix: providerApiKey.keyPrefix } : {}),
          providerModelId: candidate.providerModelId,
        });
        return {
          candidate: {
            ...candidate,
            apiKey: providerApiKey.apiKey,
            providerApiKeyId: providerApiKey.providerApiKeyId,
            providerApiKeyPrefix: providerApiKey.keyPrefix,
          },
          result,
        };
      }

      const failedAttempt = buildFallbackFailedAttempt({
        attemptOrder,
        providerApiKey,
        providerModelId: candidate.providerModelId,
        result,
      });
      input.fallbackAttempts.push(failedAttempt);
      await recordFailedAttemptInDatabase(input, failedAttempt);
      if (!failedAttempt.failedBeforeFirstByte) {
        return undefined;
      }
    }
  }
  return undefined;
}

function buildRequestActivityRoute(input: {
  candidate: GatewayRouteCandidateSnapshot & {
    providerApiKeyId?: string;
    providerApiKeyPrefix?: string;
  };
  fallbackAttempts: FallbackFailedAttempt[];
  routeDecision: ReturnType<typeof selectRouteCandidate>;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: input.fallbackAttempts,
    modelId: input.candidate.modelId,
    providerApiKeyId: input.candidate.providerApiKeyId,
    providerApiKeyPrefix: input.candidate.providerApiKeyPrefix,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
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

function requireFirstCandidate(
  candidates: readonly GatewayRouteCandidateSnapshot[],
): GatewayRouteCandidateSnapshot {
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error("Selected route candidate was not found in route policy.");
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
