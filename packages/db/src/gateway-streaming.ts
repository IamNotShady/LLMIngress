import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { getPostgresPool } from "@llmingress/db/client";
import { selectRouteAttempts } from "@llmingress/domain";
import type { NormalizedAnthropicMessagesRequest } from "@llmingress/provider/anthropic";
import {
  type ProviderStreamingDialect,
  resolveProviderStreamingDialect,
} from "@llmingress/provider/dialect";
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
import type { GatewayConfigSnapshot } from "./gateway-config-reload.ts";
import { gatewayInstanceId, gatewayStreamConnectTimeoutMs } from "./gateway-env.ts";
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";
import {
  createGatewayErrorBody,
  type GatewayErrorCode,
  toGatewayErrorResponseParts,
} from "./gateway-errors.ts";
import {
  buildFallbackFailedAttempt,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  readFallbackProviderApiKeys,
} from "./gateway-fallback-chain.ts";
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
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayStreamingResult> {
  const normalized = buildStreamingPayload({
    protocol: input.protocol,
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
    assertGatewayRoutePolicyEndpointProtocol({
      protocol: input.protocol,
      routePolicy,
    });
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const gatewayChain = routeResult.chain;

    if (gatewayChain.length === 0) {
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

    const fallbackAttempts: FallbackFailedAttempt[] = [];
    let attemptOrder = 0;
    // Track outcome of last real (non-skipped) attempt for exhaustion error code.
    let lastFailureCode: GatewayErrorCode | undefined;
    // Track whether any candidates were actually attempted (not just skipped as unsupported).
    let anyAttempted = false;

    for (const rawCandidate of gatewayChain) {
      // --- Lazy per-candidate credentials (FIX C5) ---
      // Attach credentials for this single candidate only. If credentials are missing
      // or the provider doesn't support the streaming protocol, skip it.
      let credentialedCandidates: FallbackChainCandidate[];
      try {
        credentialedCandidates = await attachGatewayProviderCredentials({
          candidates: [rawCandidate],
          databaseUrl: input.databaseUrl,
          masterKeySource: readGatewayMasterKeySource(),
        });
      } catch {
        // Missing credentials — skip this candidate (do not abort the whole request).
        continue;
      }

      const candidate = credentialedCandidates[0];
      if (!candidate) {
        continue;
      }

      const providerDialect = resolveProviderStreamingDialect(candidate.providerKey);
      // Protocol check — if this candidate doesn't support the streaming protocol, skip it.
      if (!providerDialect.supportsPathSuffix(normalized.pathSuffix)) {
        continue;
      }

      for (const providerApiKey of readFallbackProviderApiKeys(candidate)) {
        const {
          apiKey: _candidateApiKey,
          providerApiKeyId: _candidateProviderApiKeyId,
          providerApiKeyPrefix: _candidateProviderApiKeyPrefix,
          ...candidateWithoutKey
        } = candidate;
        const attemptedCandidate: FallbackChainCandidate = {
          ...candidateWithoutKey,
          apiKey: providerApiKey.apiKey,
          ...(providerApiKey.providerApiKeyId
            ? { providerApiKeyId: providerApiKey.providerApiKeyId }
            : {}),
          ...(providerApiKey.keyPrefix ? { providerApiKeyPrefix: providerApiKey.keyPrefix } : {}),
        };

        if (!limitsEnforced) {
          const limits = await enforceGatewayAgentLimits({
            agentId: input.agentId,
            budgetPrice: attemptedCandidate.price,
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

        attemptOrder += 1;
        anyAttempted = true;
        const providerStartedAt = new Date();
        const providerUrl = providerDialect.buildUrl(
          attemptedCandidate.baseUrl,
          normalized.pathSuffix,
        );

        // --- Fetch with network-error catch ---
        let response: Response | undefined;
        let networkError: Error | undefined;
        const connectController = new AbortController();
        const connectTimeout = setTimeout(() => {
          connectController.abort(
            new Error("Provider connection timed out before response headers."),
          );
        }, streamConnectTimeoutMs());
        connectTimeout.unref?.();
        try {
          response = await (input.fetch ?? globalThis.fetch)(providerUrl, {
            body: JSON.stringify(
              buildStreamingRequestBodyForDialect({
                dialect: providerDialect,
                modelId: attemptedCandidate.modelId,
                pathSuffix: normalized.pathSuffix,
                payload: normalized.payload,
              }),
            ),
            headers: providerDialect.buildHeaders(
              attemptedCandidate.apiKey,
              normalized.headersWithApiKey,
            ),
            method: "POST",
            signal: connectController.signal,
          });
        } catch (err) {
          networkError = err instanceof Error ? err : new Error("Provider network error.");
        } finally {
          clearTimeout(connectTimeout);
        }

        if (networkError || !response) {
          // Network-level failure — build failed attempt via the shared helper (FIX m2).
          recordGatewayProviderTrace({
            errorCode: "provider_request_failed",
            modelId: attemptedCandidate.modelId,
            providerKey: attemptedCandidate.providerKey,
            requestId: input.requestId,
            startedAt: providerStartedAt,
            status: "failed",
          });
          const failedAttempt = buildFallbackFailedAttempt({
            attemptOrder,
            providerApiKey,
            providerModelId: attemptedCandidate.providerModelId,
            result: {
              errorCode: "provider_request_failed",
              errorMessage: networkError?.message ?? "Provider network error.",
              statusCode: null, // network error → null → retryable
            },
          });
          fallbackAttempts.push(failedAttempt);
          lastFailureCode = "provider_request_failed";
          continue; // retryable — advance to next candidate
        }

        recordGatewayProviderTrace({
          errorCode: response.ok && response.body ? null : "provider_request_failed",
          modelId: attemptedCandidate.modelId,
          providerKey: attemptedCandidate.providerKey,
          requestId: input.requestId,
          startedAt: providerStartedAt,
          status: response.ok && response.body ? "succeeded" : "failed",
        });

        if (!response.ok || !response.body) {
          // HTTP-level error — determine retryability from status.
          const providerError = await readProviderErrorBody(response);
          console.error("gateway provider streaming request failed", {
            modelId: attemptedCandidate.modelId,
            providerKey: attemptedCandidate.providerKey,
            requestId: input.requestId,
            statusCode: response.status,
            url: providerUrl,
          });

          const errorCode: GatewayErrorCode =
            response.status === 429
              ? "provider_rate_limited"
              : response.status >= 400 && response.status < 500
                ? "provider_rejected_request"
                : "provider_request_failed";
          const retryable = response.status === 429 || response.status >= 500;

          // Use buildFallbackFailedAttempt with the REAL statusCode (FIX m1: statusCode is real).
          const failedAttempt = buildFallbackFailedAttempt({
            attemptOrder,
            providerApiKey,
            providerModelId: attemptedCandidate.providerModelId,
            result: {
              errorCode,
              errorMessage: providerError.message ?? "Provider request failed.",
              statusCode: response.status,
            },
          });
          fallbackAttempts.push(failedAttempt);
          lastFailureCode = errorCode;

          if (retryable) {
            // Continue to next candidate.
            continue;
          }
          // Non-retryable (4xx other than 429) — stop the chain.
          await releaseGatewayConcurrency({
            databaseUrl: input.databaseUrl,
            lease: concurrencyLease,
          });
          concurrencyLease = undefined;
          return {
            body: providerError.body,
            ok: false,
            requestMetadata: normalized.requestMetadata,
            statusCode: response.status,
          };
        }

        // --- 200 + body: read-ahead the first chunk before committing to the client (P1) ---
        // getReader() locks the web stream, so the remainder is pumped via this reader below.
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
          // Stream errored, timed out, or sent nothing before the first byte reached the
          // client -> retryable failed attempt; we can still try the next candidate.
          await reader.cancel().catch(() => undefined);
          recordGatewayProviderTrace({
            errorCode: "provider_request_failed",
            modelId: attemptedCandidate.modelId,
            providerKey: attemptedCandidate.providerKey,
            requestId: input.requestId,
            startedAt: providerStartedAt,
            status: "failed",
          });
          const failedAttempt = buildFallbackFailedAttempt({
            attemptOrder,
            providerApiKey,
            providerModelId: attemptedCandidate.providerModelId,
            result: {
              errorCode: "provider_request_failed",
              errorMessage: readaheadError ?? "Provider returned an empty stream.",
              statusCode: null, // before first byte -> null -> retryable
            },
          });
          fallbackAttempts.push(failedAttempt);
          lastFailureCode = "provider_request_failed";
          continue; // retryable — advance to next candidate
        }
        const firstValue = firstChunk.value;

        // --- SUCCESS — first chunk confirmed, this candidate wins ---
        recordGatewayProviderApiKeyLastUsed({
          databaseUrl: input.databaseUrl,
          providerApiKeyId: attemptedCandidate.providerApiKeyId,
        });

        const activity = buildGatewayRequestActivityRoute({
          candidate: attemptedCandidate,
          fallbackAttempts,
          routeDecision,
        });

        const body = composeGatewayProviderStreamPipeline({
          candidate: attemptedCandidate,
          databaseUrl: input.databaseUrl,
          firstValue,
          lease: concurrencyLease,
          reader,
          recordRuntimeError: (error) =>
            recordGatewayRuntimeError({
              databaseUrl: input.databaseUrl,
              error,
              metadata: {
                protocol: input.protocol,
                providerModelId: attemptedCandidate.providerModelId,
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
          contentType: response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
          ok: true,
          requestMetadata: normalized.requestMetadata,
          statusCode: response.status,
          usageCost: {
            actualPrice: attemptedCandidate.price,
            baselinePrice: baselineCandidate.price,
            baselineProviderModelId: baselineCandidate.providerModelId,
            estimatedInputTokens: normalized.estimatedInputTokens,
            estimatedOutputTokens: normalized.estimatedOutputTokens,
            providerModelId: attemptedCandidate.providerModelId,
          },
        };
      }
    }

    // Loop ended without a success — all candidates were either skipped or failed.
    await releaseGatewayConcurrency({ databaseUrl: input.databaseUrl, lease: concurrencyLease });
    concurrencyLease = undefined;

    // FIX C2: distinguish "all unsupported/skipped" from "exhausted via real failures".
    // anyAttempted is only true when at least one candidate was actually fetched.
    if (!anyAttempted) {
      return {
        body: createGatewayErrorBody("provider_protocol_unsupported", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_protocol_unsupported"),
      };
    }
    // Return error code reflecting the last real failure (FIX C2).
    const exhaustionCode = lastFailureCode ?? "provider_request_failed";
    return {
      body: createGatewayErrorBody(exhaustionCode, input.requestId),
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: mapGatewayErrorStatus(exhaustionCode),
    };
  } catch (error) {
    // Outer catch: release any unreleased concurrency lease.
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

const FIRST_CHUNK_TIMEOUT_MS = 30_000;

export function streamConnectTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return gatewayStreamConnectTimeoutMs(env);
}

function buildStreamingPayload(input: {
  protocol: GatewayStreamingProtocol;
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
      headersWithApiKey: (apiKey) => ({
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
      headersWithApiKey: (apiKey) => ({
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
    headersWithApiKey: (apiKey) => ({
      "anthropic-version": "2023-06-01",
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

async function readProviderErrorBody(
  response: Response,
): Promise<{ body: unknown; message: string | null }> {
  try {
    const text = await response.text();
    if (!text) {
      return { body: null, message: null };
    }
    try {
      const body = JSON.parse(text) as unknown;
      return {
        body,
        message: readProviderErrorMessage(body) ?? text.slice(0, 2000),
      };
    } catch {
      return {
        body: text,
        message: text.slice(0, 2000),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read provider error body.";
    return {
      body: { error: { message } },
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
