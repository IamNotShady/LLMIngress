import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { getPostgresPool } from "@llmingress/db/client";
import { selectRouteAttempts } from "@llmingress/domain";
import { createLogger } from "@llmingress/logging";
import type { NormalizedAnthropicMessagesRequest } from "@llmingress/provider/anthropic";
import {
  fetchCredentialedProviderRequest,
  isProviderRedirectRejectedError,
} from "@llmingress/provider/authenticated-http";
import {
  type ProviderStreamingDialect,
  resolveProviderStreamingDialect,
} from "@llmingress/provider/dialect";
import { readProviderResponseHeaders } from "@llmingress/provider/headers";
import type {
  NormalizedOpenAIChatRequest,
  NormalizedOpenAIResponsesRequest,
} from "@llmingress/provider/openai";
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import {
  enforceGatewayAgentLimits,
  type GatewayBudgetSettlement,
  type GatewayConcurrencyLease,
  releaseGatewayConcurrency,
} from "./gateway-agent-limits.ts";
import { runGatewayBackgroundTask } from "./gateway-background-tasks.ts";
import { normalizeOpenAIChatCompletionRequest } from "./gateway-chat-completions.ts";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
} from "./gateway-config-reload.ts";
import { gatewayInstanceId, gatewayStreamConnectTimeoutMs } from "./gateway-env.ts";
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";
import {
  createGatewayErrorBody,
  type GatewayErrorCode,
  toGatewayErrorResponseParts,
} from "./gateway-errors.ts";
import {
  buildFallbackExhaustionError,
  executeProviderFallbackAttempts,
  type FallbackAttemptErrorLike,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  type FallbackProviderApiKey,
  type ProviderFallbackAttemptResult,
  type ProviderFallbackAttemptSuccess,
} from "./gateway-fallback-chain.ts";
import { mergeGatewayHttpHeaders, readGatewayHeaderValue } from "./gateway-header-passthrough.ts";
import { normalizeAnthropicMessagesRequest } from "./gateway-messages.ts";
import {
  attachGatewayProviderCredentials,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./gateway-provider-credentials.ts";
import {
  buildAnthropicMessagesRequestMetadata,
  buildOpenAIChatCompletionRequestMetadata,
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./gateway-request-metadata.ts";
import { normalizeOpenAIResponsesRequest } from "./gateway-responses.ts";
import {
  assertGatewayRoutePolicyEndpointProtocol,
  buildGatewayRequestActivityRoute,
  isRecord,
  requireGatewayRoutePolicy,
  requireGatewayRoutePolicyForVirtualModel,
  selectGatewayBaselineCandidate,
} from "./gateway-runtime-helpers.ts";
import {
  composeGatewayProviderStreamPipeline,
  type GatewayRuntimeStreamError,
  readChunkWithTimeout,
} from "./gateway-stream-pipeline.ts";
import { recordGatewayProviderTrace } from "./gateway-tracing.ts";
import type { GatewayUsageCostDetails } from "./gateway-usage-recorder.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";
import {
  assertGatewayRequestWithinVirtualModelContract,
  assertGatewayVirtualModelCapabilityContract,
} from "./gateway-virtual-model-capabilities.ts";

const logger = createLogger("gateway");

export type GatewayStreamingProtocol = "chat_completions" | "messages" | "responses";

export type GatewayStreamingResult =
  | {
      body: Readable;
      budgetSettlement?: GatewayBudgetSettlement;
      contentType: string;
      activity?: GatewayRequestActivityRoute;
      headers?: Record<string, string>;
      ok: true;
      requestMetadata: GatewayRequestMetadata;
      statusCode: number;
      usageCost?: GatewayUsageCostDetails;
    }
  | {
      body: unknown;
      activity?: GatewayRequestActivityRoute;
      headers?: Record<string, string>;
      ok: false;
      requestMetadata?: GatewayRequestMetadata;
      statusCode: number;
    };

type GatewayStreamingPayload = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  pathSuffix: string;
  requestMetadata: GatewayRequestMetadata;
};

export function readGatewayStreamingFlag(body: unknown): boolean {
  return isRecord(body) && body.stream === true;
}

export async function executeGatewayStreamingRequest(input: {
  agentId: string;
  databaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  protocol: GatewayStreamingProtocol;
  providerRequestHeaders?: Record<string, string>;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayStreamingResult> {
  const normalized = buildStreamingPayload({
    protocol: input.protocol,
    providerRequestHeaders: input.providerRequestHeaders,
    requestBody: input.requestBody,
    requestId: input.requestId,
    resolvedModelName: input.virtualModel.name,
  });
  if (!normalized.ok) {
    return normalized;
  }

  let concurrencyLease: GatewayConcurrencyLease | undefined;
  let budgetSettlement: GatewayBudgetSettlement | undefined;
  let limitsEnforced = false;

  try {
    const configuredRoutePolicy = requireGatewayRoutePolicyForVirtualModel(
      input.snapshot,
      input.virtualModel.id,
    );
    assertGatewayRoutePolicyEndpointProtocol({
      protocol: input.protocol,
      routePolicy: configuredRoutePolicy,
    });
    const capabilityContract = assertGatewayVirtualModelCapabilityContract(configuredRoutePolicy);
    assertGatewayRequestWithinVirtualModelContract(capabilityContract, normalized.requestMetadata);

    const routeResult = selectRouteAttempts({
      estimatedInputTokens: normalized.estimatedInputTokens,
      estimatedOutputTokens: normalized.estimatedOutputTokens,
      snapshot: input.snapshot,
      usesTools: normalized.requestMetadata.usesTools,
      virtualModelId: input.virtualModel.id,
    });

    if (!routeResult.decision || routeResult.chain.length === 0) {
      await releaseGatewayConcurrency({ databaseUrl: input.databaseUrl, lease: concurrencyLease });
      concurrencyLease = undefined;
      return {
        body: createGatewayErrorBody(
          "provider_unavailable",
          input.requestId,
          "No provider is available for the selected route.",
        ),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_unavailable"),
      };
    }

    const routeDecision = routeResult.decision;
    const routePolicy = requireGatewayRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const gatewayChain = routeResult.chain;

    const fallbackAttempts: FallbackFailedAttempt[] = [];
    let lastError: FallbackAttemptErrorLike | undefined;
    const candidates = await buildStreamingFallbackCandidates({
      candidates: gatewayChain,
      databaseUrl: input.databaseUrl,
      pathSuffix: normalized.pathSuffix,
    });

    if (candidates.length === 0) {
      return {
        body: createGatewayErrorBody("provider_protocol_unsupported", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_protocol_unsupported"),
      };
    }

    if (!limitsEnforced) {
      const limits = await enforceGatewayAgentLimits({
        agentId: input.agentId,
        budgetPrice: candidates[0]?.price,
        databaseUrl: input.databaseUrl,
        requestId: input.requestId,
        requestMetadata: normalized.requestMetadata,
      });
      if (!limits.ok) {
        return {
          body: limits.body,
          ...(limits.retryAfterSeconds
            ? { headers: { "retry-after": String(limits.retryAfterSeconds) } }
            : {}),
          ok: false,
          requestMetadata: normalized.requestMetadata,
          statusCode: limits.statusCode,
        };
      }
      concurrencyLease = limits.concurrencyLease;
      budgetSettlement = limits.budgetSettlement;
      limitsEnforced = true;
    }

    const success = await executeProviderFallbackAttempts<StreamingProviderSuccess>({
      callProvider: async ({ candidate, providerApiKey }) => {
        const result = await callStreamingProvider({
          candidate,
          fetch: input.fetch ?? globalThis.fetch,
          normalized,
          providerApiKey,
          requestId: input.requestId,
        });
        if (!result.ok) {
          lastError = result;
        }
        return result;
      },
      candidates,
      databaseUrl: input.databaseUrl,
      fallbackAttempts,
      requestId: input.requestId,
    });

    if (!success) {
      await releaseGatewayConcurrency({ databaseUrl: input.databaseUrl, lease: concurrencyLease });
      concurrencyLease = undefined;
      const providerError = buildStreamingProviderErrorPassthrough(lastError);
      if (providerError) {
        return {
          body: providerError.body,
          headers: providerError.headers,
          ok: false,
          requestMetadata: normalized.requestMetadata,
          statusCode: providerError.statusCode,
        };
      }
      const parts = toGatewayErrorResponseParts(
        buildFallbackExhaustionError(lastError),
        "provider_request_failed",
      );
      return {
        body: createGatewayErrorBody(parts.code, input.requestId, parts.message),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: parts.statusCode,
      };
    }

    recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: success.candidate.providerApiKeyId,
    });

    const activity = buildGatewayRequestActivityRoute({
      candidate: success.candidate,
      fallbackAttempts,
      routeDecision,
    });
    const body = composeGatewayProviderStreamPipeline({
      candidate: success.candidate,
      databaseUrl: input.databaseUrl,
      firstValue: success.result.firstValue,
      lease: concurrencyLease,
      reader: success.result.reader,
      recordRuntimeError: (error) =>
        recordGatewayRuntimeError({
          databaseUrl: input.databaseUrl,
          error,
          metadata: {
            protocol: input.protocol,
            providerModelId: success.candidate.providerModelId,
            requestId: input.requestId,
            virtualModelId: input.virtualModel.id,
          },
        }),
    });
    concurrencyLease = undefined;

    return {
      activity,
      body,
      budgetSettlement,
      contentType: success.result.contentType,
      headers: success.result.headers,
      ok: true,
      requestMetadata: normalized.requestMetadata,
      statusCode: success.result.statusCode,
      usageCost: {
        actualPrice: success.candidate.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: normalized.estimatedInputTokens,
        estimatedOutputTokens: normalized.estimatedOutputTokens,
        providerModelId: success.candidate.providerModelId,
      },
    };
  } catch (error) {
    await releaseGatewayConcurrency({
      databaseUrl: input.databaseUrl,
      lease: concurrencyLease,
    });
    const parts = toGatewayErrorResponseParts(error, "provider_request_failed");
    return {
      body: createGatewayErrorBody(parts.code, input.requestId, parts.message),
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: parts.statusCode,
    };
  }
}

type StreamingProviderSuccess = ProviderFallbackAttemptSuccess & {
  body: null;
  contentType: string;
  firstValue: Uint8Array;
  headers: Record<string, string>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
};

async function buildStreamingFallbackCandidates(input: {
  candidates: readonly GatewayRouteCandidateSnapshot[];
  databaseUrl?: string;
  pathSuffix: string;
}): Promise<FallbackChainCandidate[]> {
  const supported: FallbackChainCandidate[] = [];
  for (const rawCandidate of input.candidates) {
    let credentialedCandidates: FallbackChainCandidate[];
    try {
      credentialedCandidates = await attachGatewayProviderCredentials({
        candidates: [rawCandidate],
        databaseUrl: input.databaseUrl,
        masterKeySource: readGatewayMasterKeySource(),
      });
    } catch {
      continue;
    }

    const candidate = credentialedCandidates[0];
    if (!candidate) {
      continue;
    }

    const providerDialect = resolveProviderStreamingDialect(candidate.providerKey);
    if (providerDialect.supportsPathSuffix(input.pathSuffix)) {
      supported.push(candidate);
    }
  }
  return supported;
}

async function callStreamingProvider(input: {
  candidate: FallbackChainCandidate;
  fetch: typeof globalThis.fetch;
  normalized: GatewayStreamingPayload & {
    headersWithApiKey: (apiKey: string) => Record<string, string>;
    ok: true;
  };
  providerApiKey: FallbackProviderApiKey;
  requestId: string;
}): Promise<ProviderFallbackAttemptResult<StreamingProviderSuccess>> {
  const attemptedCandidate = buildStreamingAttemptCandidate({
    candidate: input.candidate,
    providerApiKey: input.providerApiKey,
  });
  const providerDialect = resolveProviderStreamingDialect(attemptedCandidate.providerKey);
  const providerStartedAt = new Date();
  const providerUrl = providerDialect.buildUrl(
    attemptedCandidate.baseUrl,
    input.normalized.pathSuffix,
  );

  const responseResult = await fetchStreamingProviderResponse({
    attemptedCandidate,
    fetch: input.fetch,
    normalized: input.normalized,
    providerDialect,
    providerUrl,
  });
  if (!responseResult.ok) {
    recordGatewayProviderTrace({
      errorCode: responseResult.errorCode,
      modelId: attemptedCandidate.modelId,
      providerKey: attemptedCandidate.providerKey,
      requestId: input.requestId,
      startedAt: providerStartedAt,
      status: "failed",
    });
    return responseResult;
  }

  const response = responseResult.response;
  if (!response.ok || !response.body) {
    const providerError = await readProviderErrorBody(response);
    logger.error(
      {
        modelId: attemptedCandidate.modelId,
        providerKey: attemptedCandidate.providerKey,
        requestId: input.requestId,
        statusCode: response.status,
        url: providerUrl,
      },
      "gateway provider streaming request failed",
    );
    const errorCode: GatewayErrorCode =
      response.status === 429
        ? "provider_rate_limited"
        : response.status >= 400 && response.status < 500
          ? "provider_rejected_request"
          : "provider_request_failed";
    recordGatewayProviderTrace({
      errorCode,
      modelId: attemptedCandidate.modelId,
      providerKey: attemptedCandidate.providerKey,
      requestId: input.requestId,
      startedAt: providerStartedAt,
      status: "failed",
    });
    return {
      body: providerError.body,
      errorCode,
      errorMessage: providerError.message ?? "Provider request failed.",
      failedBeforeFirstByte: true,
      headers: providerError.headers,
      ok: false,
      statusCode: response.status,
    };
  }

  const reader = response.body.getReader();
  let firstChunk: ReadableStreamReadResult<Uint8Array> | undefined;
  let readaheadError: string | undefined;
  try {
    firstChunk = await readChunkWithTimeout(
      reader,
      FIRST_CHUNK_TIMEOUT_MS,
      "Provider stream timed out before first byte.",
    );
  } catch (streamError) {
    readaheadError =
      streamError instanceof Error
        ? streamError.message
        : "Provider stream failed before first byte.";
  }

  if (readaheadError !== undefined || !firstChunk || firstChunk.done) {
    await reader.cancel().catch(() => undefined);
    recordGatewayProviderTrace({
      errorCode: "provider_request_failed",
      modelId: attemptedCandidate.modelId,
      providerKey: attemptedCandidate.providerKey,
      requestId: input.requestId,
      startedAt: providerStartedAt,
      status: "failed",
    });
    return {
      errorCode: "provider_request_failed",
      errorMessage: readaheadError ?? "Provider returned an empty stream.",
      failedBeforeFirstByte: true,
      ok: false,
      statusCode: null,
    };
  }

  recordGatewayProviderTrace({
    errorCode: null,
    modelId: attemptedCandidate.modelId,
    providerKey: attemptedCandidate.providerKey,
    requestId: input.requestId,
    startedAt: providerStartedAt,
    status: "succeeded",
  });

  return {
    body: null,
    contentType: response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    firstValue: firstChunk.value,
    headers: readProviderResponseHeaders(response.headers),
    ok: true,
    reader,
    statusCode: response.status,
  };
}

function buildStreamingAttemptCandidate(input: {
  candidate: FallbackChainCandidate;
  providerApiKey: FallbackProviderApiKey;
}): FallbackChainCandidate {
  const {
    apiKey: _candidateApiKey,
    providerApiKeyId: _candidateProviderApiKeyId,
    providerApiKeyPrefix: _candidateProviderApiKeyPrefix,
    ...candidateWithoutKey
  } = input.candidate;
  return {
    ...candidateWithoutKey,
    apiKey: input.providerApiKey.apiKey,
    ...(input.providerApiKey.providerApiKeyId
      ? { providerApiKeyId: input.providerApiKey.providerApiKeyId }
      : {}),
    ...(input.providerApiKey.keyPrefix
      ? { providerApiKeyPrefix: input.providerApiKey.keyPrefix }
      : {}),
  };
}

async function fetchStreamingProviderResponse(input: {
  attemptedCandidate: FallbackChainCandidate;
  fetch: typeof globalThis.fetch;
  normalized: GatewayStreamingPayload & {
    headersWithApiKey: (apiKey: string) => Record<string, string>;
    ok: true;
  };
  providerDialect: ProviderStreamingDialect;
  providerUrl: string;
}): Promise<
  | { ok: true; response: Response }
  | (FallbackAttemptErrorLike & {
      ok: false;
    })
> {
  const connectController = new AbortController();
  const connectTimeout = setTimeout(() => {
    connectController.abort(new Error("Provider connection timed out before response headers."));
  }, streamConnectTimeoutMs());
  connectTimeout.unref?.();
  try {
    const response = await fetchCredentialedProviderRequest(input.fetch, input.providerUrl, {
      body: JSON.stringify(
        buildStreamingRequestBodyForDialect({
          dialect: input.providerDialect,
          modelId: input.attemptedCandidate.modelId,
          pathSuffix: input.normalized.pathSuffix,
          payload: input.normalized.payload,
        }),
      ),
      headers: input.providerDialect.buildHeaders(
        input.attemptedCandidate.apiKey,
        input.normalized.headersWithApiKey,
      ),
      method: "POST",
      signal: connectController.signal,
    });
    return { ok: true, response };
  } catch (err) {
    if (isProviderRedirectRejectedError(err)) {
      return {
        errorCode: "provider_redirect_rejected",
        errorMessage: err.message,
        failedBeforeFirstByte: true,
        ok: false,
        statusCode: err.statusCode,
      };
    }
    return {
      errorCode: "provider_request_failed",
      errorMessage: err instanceof Error ? err.message : "Provider network error.",
      failedBeforeFirstByte: true,
      ok: false,
      statusCode: null,
    };
  } finally {
    clearTimeout(connectTimeout);
  }
}

function buildStreamingProviderErrorPassthrough(
  error: FallbackAttemptErrorLike | undefined,
): { body: unknown; headers?: Record<string, string>; statusCode: number } | null {
  const statusCode = error?.statusCode;
  if (statusCode === undefined || statusCode === null) {
    return null;
  }
  if (statusCode < 400 || statusCode >= 500) {
    return null;
  }
  if (!error || !("body" in error)) {
    return null;
  }
  return {
    body: error.body ?? null,
    headers: error.headers,
    statusCode,
  };
}

const FIRST_CHUNK_TIMEOUT_MS = 30_000;

export function streamConnectTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return gatewayStreamConnectTimeoutMs(env);
}

function buildStreamingPayload(input: {
  protocol: GatewayStreamingProtocol;
  providerRequestHeaders?: Record<string, string>;
  requestBody: unknown;
  requestId: string;
  resolvedModelName: string;
}):
  | (GatewayStreamingPayload & {
      headersWithApiKey: (apiKey: string) => Record<string, string>;
      ok: true;
    })
  | {
      body: unknown;
      ok: false;
      statusCode: number;
    } {
  if (input.protocol === "chat_completions") {
    const normalized = normalizeOpenAIChatCompletionRequest(input.requestBody, input.requestId);
    if (!normalized.ok) {
      return normalized;
    }
    const requestMetadata = buildOpenAIChatCompletionRequestMetadata({
      model: input.resolvedModelName,
      rawBody: input.requestBody,
      request: normalized.request,
    });

    return {
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      headers: { "content-type": "application/json" },
      headersWithApiKey: (apiKey) =>
        mergeGatewayHttpHeaders(input.providerRequestHeaders, {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        }),
      ok: true,
      pathSuffix: "chat/completions",
      payload: buildOpenAIChatStreamingPayload(normalized.request),
      requestMetadata,
    };
  }

  if (input.protocol === "responses") {
    const normalized = normalizeOpenAIResponsesRequest(input.requestBody, input.requestId);
    if (!normalized.ok) {
      return normalized;
    }
    const requestMetadata = buildOpenAIResponsesRequestMetadata({
      model: input.resolvedModelName,
      rawBody: input.requestBody,
      request: normalized.request,
    });

    return {
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      headers: { "content-type": "application/json" },
      headersWithApiKey: (apiKey) =>
        mergeGatewayHttpHeaders(input.providerRequestHeaders, {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        }),
      ok: true,
      pathSuffix: "responses",
      payload: buildOpenAIResponsesStreamingPayload(normalized.request),
      requestMetadata,
    };
  }

  const normalized = normalizeAnthropicMessagesRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return normalized;
  }
  const requestMetadata = buildAnthropicMessagesRequestMetadata({
    model: input.resolvedModelName,
    rawBody: input.requestBody,
    request: normalized.request,
  });

  return {
    estimatedInputTokens: requestMetadata.estimatedInputTokens,
    estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
    headers: { "content-type": "application/json" },
    headersWithApiKey: (apiKey) =>
      mergeGatewayHttpHeaders(input.providerRequestHeaders, {
        "anthropic-version":
          readGatewayHeaderValue(input.providerRequestHeaders, "anthropic-version") ?? "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      }),
    ok: true,
    pathSuffix: "messages",
    payload: buildAnthropicMessagesStreamingPayload(normalized.request),
    requestMetadata,
  };
}

function buildOpenAIChatStreamingPayload(
  request: NormalizedOpenAIChatRequest,
): Record<string, unknown> {
  return request.payload;
}

function buildOpenAIResponsesStreamingPayload(
  request: NormalizedOpenAIResponsesRequest,
): Record<string, unknown> {
  return request.payload;
}

function buildAnthropicMessagesStreamingPayload(
  request: NormalizedAnthropicMessagesRequest,
): Record<string, unknown> {
  return request.payload;
}

function recordGatewayRuntimeError(input: {
  databaseUrl?: string;
  error: GatewayRuntimeStreamError;
  metadata: Record<string, unknown>;
}): void {
  runGatewayBackgroundTask({
    message: "gateway runtime stream error recording failed",
    metadata: {
      errorCode: input.error.errorCode,
      requestId: input.metadata.requestId,
    },
    name: "gateway.stream.runtime_error",
    task: async () => {
      await getPostgresPool(input.databaseUrl).query(
        `
          insert into runtime_errors (
            id,
            process_type,
            process_id,
            severity,
            error_code,
            error_message,
            metadata
          )
          values ($1, 'gateway', $2, 'error', $3, $4, $5)
        `,
        [
          randomUUID(),
          gatewayInstanceId(),
          input.error.errorCode,
          input.error.errorMessage,
          JSON.stringify(input.metadata),
        ],
      );
    },
  });
}

function buildStreamingRequestBodyForDialect(input: {
  dialect: ProviderStreamingDialect;
  modelId: string;
  pathSuffix: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  let body = buildProviderRequestBody(input.payload, input.modelId);
  body = input.dialect.transformBody(body, input.pathSuffix);
  return body;
}

function buildProviderRequestBody(
  payload: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  return {
    ...payload,
    model: modelId,
  };
}

async function readProviderErrorBody(response: Response): Promise<{
  body: unknown;
  headers: Record<string, string>;
  message: string | null;
}> {
  const headers = readProviderResponseHeaders(response.headers);
  try {
    const text = await response.text();
    if (!text) {
      return { body: null, headers, message: null };
    }
    try {
      const body = JSON.parse(text) as unknown;
      return {
        body,
        headers,
        message: readProviderErrorMessage(body) ?? text.slice(0, 2000),
      };
    } catch {
      return {
        body: text,
        headers,
        message: text.slice(0, 2000),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read provider error body.";
    return {
      body: { error: { message } },
      headers,
      message,
    };
  }
}

function readProviderErrorMessage(body: unknown): string | null {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  return null;
}
