import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import { PostgresClient } from "@llmingress/db/providers";
import { omitUnsupportedAnthropicSamplingParameters } from "@llmingress/provider/anthropic";
import { classifyProviderFailureStatus } from "@llmingress/provider/connectivity";
import { openRouterAttributionHeaders } from "@llmingress/provider/openrouter";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
  normalizeCodexResponsesInput,
  withClaudeCodeSystemPrompt,
} from "@llmingress/provider/subscription";
import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
import {
  finalizeGatewayBudgetReservation,
  type GatewayBudgetReservation,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./budgets.js";
import {
  attachGatewayProviderCredentials,
  normalizeOpenAIChatCompletionRequest,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./chat-completions.js";
import type { GatewayConfigSnapshot, GatewayRoutePolicySnapshot } from "./config-reload.js";
import { mapGatewayErrorStatus } from "./error-mapping.js";
import {
  buildFallbackFailedAttempt,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  recordFailedAttemptInDatabase,
  recordSucceededAttemptInDatabase,
} from "./fallback-chain.js";
import { normalizeAnthropicMessagesRequest } from "./messages.js";
import {
  enforceGatewayRateLimits,
  type GatewayConcurrencyLease,
  releaseGatewayConcurrency,
} from "./rate-limits.js";
import {
  buildAnthropicMessagesRequestMetadata,
  buildOpenAIChatCompletionRequestMetadata,
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { normalizeOpenAIResponsesRequest } from "./responses.js";
import { type RouteDecision, selectRouteAttempts } from "./route-engine.js";
import { recordGatewayProviderTrace } from "./tracing.js";
import { type GatewayUsageCostDetails, selectGatewayBaselineCandidate } from "./usage-recorder.js";
import type { GatewayVirtualModel } from "./virtual-model-access.js";

export type GatewayStreamingProtocol = "chat_completions" | "messages" | "responses";

export type GatewayStreamingResult =
  | {
      body: Readable;
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

export type GatewayRuntimeStreamError = {
  errorCode: "provider_stream_error";
  errorMessage: string;
};

type GatewayStreamingErrorCode =
  | "provider_credentials_missing"
  | "provider_protocol_unsupported"
  | "provider_rate_limited"
  | "provider_request_failed"
  | "provider_unavailable"
  | "route_not_found";

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
  agentApiKeyId: string;
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  protocol: GatewayStreamingProtocol;
  requestActivityId?: string;
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

  const rateLimit = await enforceGatewayRateLimits({
    agentApiKeyId: input.agentApiKeyId,
    databaseUrl: input.databaseUrl,
    requestId: input.requestId,
    requestMetadata: normalized.requestMetadata,
  });
  if (!rateLimit.ok) {
    return {
      body: rateLimit.body,
      headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: rateLimit.statusCode,
    };
  }

  // Concurrency lease: acquired once, released exactly once — either in the stream wrapper
  // on success, in each early-return error path, or in the outer catch.
  let concurrencyLease: GatewayConcurrencyLease | undefined = rateLimit.concurrencyLease;
  // currentReservation holds the active budget reservation for the candidate currently being
  // attempted. It is set BEFORE reserving and cleared (= undefined) whenever ownership is
  // transferred (to the stream wrapper on success) or released (on failure/skip). The outer
  // catch releases it if still set, guaranteeing no reservation can ever leak.
  let currentReservation: GatewayBudgetReservation | undefined;

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
        body: createGatewayStreamingErrorBody("provider_unavailable", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_unavailable"),
      };
    }

    const routeDecision = routeResult.decision;
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);

    // Reconstruct ordered chain from routePolicy.candidates (preserving GatewayRouteCandidateSnapshot
    // with healthStatus) using the same ordering as routeResult.chain.
    const chainOrderMap = new Map(routeResult.chain.map((c, idx) => [c.candidateOrder, idx]));
    const gatewayChain = routePolicy.candidates
      .filter((c) => chainOrderMap.has(c.candidateOrder))
      .sort((a, b) => {
        const ia = chainOrderMap.get(a.candidateOrder) ?? Number.MAX_SAFE_INTEGER;
        const ib = chainOrderMap.get(b.candidateOrder) ?? Number.MAX_SAFE_INTEGER;
        return ia - ib;
      });

    if (gatewayChain.length === 0) {
      await releaseGatewayConcurrency({ databaseUrl: input.databaseUrl, lease: concurrencyLease });
      concurrencyLease = undefined;
      return {
        body: createGatewayStreamingErrorBody("provider_unavailable", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_unavailable"),
      };
    }

    const fallbackAttempts: FallbackFailedAttempt[] = [];
    let attemptOrder = 0;
    // Track outcome of last real (non-skipped) attempt for exhaustion error code.
    let lastFailureCode: GatewayStreamingErrorCode | undefined;
    // Track whether any candidates were actually attempted (not just skipped as unsupported).
    let anyAttempted = false;

    for (const rawCandidate of gatewayChain) {
      // --- Lazy per-candidate credentials (FIX C5) ---
      // Attach credentials for this single candidate only. If credentials are missing
      // or the provider doesn't support the streaming protocol, release budget and continue.
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

      // Protocol check — if this candidate doesn't support the streaming protocol, skip it.
      if (
        !isStreamingProtocolSupportedByProvider({
          pathSuffix: normalized.pathSuffix,
          providerKey: candidate.providerKey,
        })
      ) {
        // Not a real attempt — no budget reservation needed, just skip.
        continue;
      }

      // --- Reserve budget for this candidate ---
      const budget = await reserveGatewayBudget({
        agentApiKeyId: input.agentApiKeyId,
        databaseUrl: input.databaseUrl,
        price: candidate.price,
        requestId: input.requestId,
        requestMetadata: normalized.requestMetadata,
      });
      if (!budget.ok) {
        // Budget rejection (402) is non-retryable — stop immediately.
        await releaseGatewayConcurrency({
          databaseUrl: input.databaseUrl,
          lease: concurrencyLease,
        });
        concurrencyLease = undefined;
        return {
          body: budget.body,
          ok: false,
          requestMetadata: normalized.requestMetadata,
          statusCode: budget.statusCode,
        };
      }
      // Set currentReservation BEFORE any async work so the outer catch can always release it.
      currentReservation = budget.reservation;

      attemptOrder += 1;
      anyAttempted = true;
      const providerStartedAt = new Date();
      const providerUrl = buildStreamingProviderUrl({
        baseUrl: candidate.baseUrl,
        pathSuffix: normalized.pathSuffix,
        providerKey: candidate.providerKey,
      });

      // --- Fetch with network-error catch ---
      let response: Response | undefined;
      let networkError: Error | undefined;
      try {
        response = await (input.fetch ?? globalThis.fetch)(providerUrl, {
          body: JSON.stringify(
            buildStreamingProviderRequestBody({
              modelId: candidate.modelId,
              pathSuffix: normalized.pathSuffix,
              payload: normalized.payload,
              providerKey: candidate.providerKey,
            }),
          ),
          headers: buildStreamingProviderHeaders({
            apiKey: candidate.apiKey,
            headersWithApiKey: normalized.headersWithApiKey,
            providerKey: candidate.providerKey,
          }),
          method: "POST",
        });
      } catch (err) {
        networkError = err instanceof Error ? err : new Error("Provider network error.");
      }

      if (networkError || !response) {
        // Network-level failure — build failed attempt via the shared helper (FIX m2).
        await recordGatewayProviderTrace({
          errorCode: "provider_request_failed",
          modelId: candidate.modelId,
          providerKey: candidate.providerKey,
          requestId: input.requestId,
          startedAt: providerStartedAt,
          status: "failed",
        });
        const failedAttempt = buildFallbackFailedAttempt({
          attemptOrder,
          providerApiKey: {
            apiKey: candidate.apiKey,
            ...(candidate.providerApiKeyId ? { providerApiKeyId: candidate.providerApiKeyId } : {}),
            ...(candidate.providerApiKeyPrefix
              ? { keyPrefix: candidate.providerApiKeyPrefix }
              : {}),
          },
          providerModelId: candidate.providerModelId,
          result: {
            errorCode: "provider_request_failed",
            errorMessage: networkError?.message ?? "Provider network error.",
            statusCode: null, // network error → null → retryable
          },
        });
        fallbackAttempts.push(failedAttempt);
        await recordFailedAttemptInDatabase(
          { databaseUrl: input.databaseUrl, requestActivityId: input.requestActivityId },
          failedAttempt,
        );
        await releaseGatewayBudgetReservation({
          databaseUrl: input.databaseUrl,
          reservation: currentReservation,
        });
        currentReservation = undefined;
        lastFailureCode = "provider_request_failed";
        continue; // retryable — advance to next candidate
      }

      await recordGatewayProviderTrace({
        errorCode: response.ok && response.body ? null : "provider_request_failed",
        modelId: candidate.modelId,
        providerKey: candidate.providerKey,
        requestId: input.requestId,
        startedAt: providerStartedAt,
        status: response.ok && response.body ? "succeeded" : "failed",
      });

      if (!response.ok || !response.body) {
        // HTTP-level error — determine retryability from status.
        const providerErrorBody = await readProviderErrorBody(response);
        console.error("gateway provider streaming request failed", {
          body: providerErrorBody,
          modelId: candidate.modelId,
          providerKey: candidate.providerKey,
          requestId: input.requestId,
          statusCode: response.status,
          url: providerUrl,
        });

        const errorCode: GatewayStreamingErrorCode =
          response.status === 429 ? "provider_rate_limited" : "provider_request_failed";
        const retryable = response.status === 429 || response.status >= 500;

        // Use buildFallbackFailedAttempt with the REAL statusCode (FIX m1: statusCode is real).
        const failedAttempt = buildFallbackFailedAttempt({
          attemptOrder,
          providerApiKey: {
            apiKey: candidate.apiKey,
            ...(candidate.providerApiKeyId ? { providerApiKeyId: candidate.providerApiKeyId } : {}),
            ...(candidate.providerApiKeyPrefix
              ? { keyPrefix: candidate.providerApiKeyPrefix }
              : {}),
          },
          providerModelId: candidate.providerModelId,
          result: {
            errorCode,
            errorMessage: providerErrorBody ?? "Provider request failed.",
            statusCode: response.status,
          },
        });
        fallbackAttempts.push(failedAttempt);
        await recordFailedAttemptInDatabase(
          { databaseUrl: input.databaseUrl, requestActivityId: input.requestActivityId },
          failedAttempt,
        );
        await releaseGatewayBudgetReservation({
          databaseUrl: input.databaseUrl,
          reservation: currentReservation,
        });
        currentReservation = undefined;
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
          body: createGatewayStreamingErrorBody(errorCode, input.requestId),
          ok: false,
          requestMetadata: normalized.requestMetadata,
          statusCode: mapGatewayErrorStatus(errorCode),
        };
      }

      // --- 200 + body: read-ahead the first chunk before committing to the client (P1) ---
      // getReader() locks the web stream, so the remainder is pumped via this reader below.
      const reader = response.body.getReader();
      let firstChunk: ReadableStreamReadResult<Uint8Array> | undefined;
      let readaheadError: string | undefined;
      try {
        firstChunk = await readFirstChunkWithTimeout(reader, FIRST_CHUNK_TIMEOUT_MS);
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
        await recordGatewayProviderTrace({
          errorCode: "provider_request_failed",
          modelId: candidate.modelId,
          providerKey: candidate.providerKey,
          requestId: input.requestId,
          startedAt: providerStartedAt,
          status: "failed",
        });
        const failedAttempt = buildFallbackFailedAttempt({
          attemptOrder,
          providerApiKey: {
            apiKey: candidate.apiKey,
            ...(candidate.providerApiKeyId ? { providerApiKeyId: candidate.providerApiKeyId } : {}),
            ...(candidate.providerApiKeyPrefix
              ? { keyPrefix: candidate.providerApiKeyPrefix }
              : {}),
          },
          providerModelId: candidate.providerModelId,
          result: {
            errorCode: "provider_request_failed",
            errorMessage: readaheadError ?? "Provider returned an empty stream.",
            statusCode: null, // before first byte -> null -> retryable
          },
        });
        fallbackAttempts.push(failedAttempt);
        await recordFailedAttemptInDatabase(
          { databaseUrl: input.databaseUrl, requestActivityId: input.requestActivityId },
          failedAttempt,
        );
        await releaseGatewayBudgetReservation({
          databaseUrl: input.databaseUrl,
          reservation: currentReservation,
        });
        currentReservation = undefined;
        lastFailureCode = "provider_request_failed";
        continue; // retryable — advance to next candidate
      }
      const firstValue = firstChunk.value;

      // --- SUCCESS — first chunk confirmed, this candidate wins ---
      await recordSucceededAttemptInDatabase(
        { databaseUrl: input.databaseUrl, requestActivityId: input.requestActivityId },
        {
          attemptOrder,
          ...(candidate.providerApiKeyId ? { providerApiKeyId: candidate.providerApiKeyId } : {}),
          ...(candidate.providerApiKeyPrefix
            ? { providerApiKeyPrefix: candidate.providerApiKeyPrefix }
            : {}),
          providerModelId: candidate.providerModelId,
        },
      );
      await recordGatewayProviderApiKeyLastUsed({
        databaseUrl: input.databaseUrl,
        providerApiKeyId: candidate.providerApiKeyId,
      });

      const activity = buildStreamingActivityRoute({
        candidate,
        fallbackAttempts,
        routeDecision,
      });

      const body = wrapProviderStreamWithConcurrencyRelease(
        wrapProviderStreamWithBudgetFinalization(
          wrapProviderStreamWithMidStreamHealthRecording(
            wrapProviderStreamWithErrorRecording(createReadaheadStream(reader, firstValue), {
              recordRuntimeError: (error) =>
                recordGatewayRuntimeError({
                  databaseUrl: input.databaseUrl,
                  error,
                  metadata: {
                    protocol: input.protocol,
                    providerModelId: candidate.providerModelId,
                    requestId: input.requestId,
                    virtualModelId: input.virtualModel.id,
                  },
                }),
            }),
            {
              databaseUrl: input.databaseUrl,
              candidate,
            },
          ),
          {
            databaseUrl: input.databaseUrl,
            reservation: currentReservation,
          },
        ),
        {
          databaseUrl: input.databaseUrl,
          lease: concurrencyLease,
        },
      );
      // Transfer ownership to stream wrappers — clear so outer catch doesn't double-release.
      currentReservation = undefined;
      concurrencyLease = undefined;

      return {
        activity,
        body,
        contentType: response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        ok: true,
        requestMetadata: normalized.requestMetadata,
        statusCode: response.status,
        usageCost: {
          actualPrice: candidate.price,
          baselinePrice: baselineCandidate.price,
          baselineProviderModelId: baselineCandidate.providerModelId,
          estimatedInputTokens: normalized.estimatedInputTokens,
          estimatedOutputTokens: normalized.estimatedOutputTokens,
          providerModelId: candidate.providerModelId,
        },
      };
    }

    // Loop ended without a success — all candidates were either skipped or failed.
    await releaseGatewayConcurrency({ databaseUrl: input.databaseUrl, lease: concurrencyLease });
    concurrencyLease = undefined;

    // FIX C2: distinguish "all unsupported/skipped" from "exhausted via real failures".
    // anyAttempted is only true when at least one candidate was actually fetched.
    if (!anyAttempted) {
      return {
        body: createGatewayStreamingErrorBody("provider_protocol_unsupported", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_protocol_unsupported"),
      };
    }
    // Return error code reflecting the last real failure (FIX C2).
    const exhaustionCode = lastFailureCode ?? "provider_request_failed";
    return {
      body: createGatewayStreamingErrorBody(exhaustionCode, input.requestId),
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: mapGatewayErrorStatus(exhaustionCode),
    };
  } catch (error) {
    // Outer catch: release any unreleased reservation + concurrency lease (FIX C1).
    await releaseGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: currentReservation,
    });
    currentReservation = undefined;
    await releaseGatewayConcurrency({
      databaseUrl: input.databaseUrl,
      lease: concurrencyLease,
    });
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyStreamingError(message);
    return {
      body: createGatewayStreamingErrorBody(
        code,
        input.requestId,
        code === "provider_request_failed" ? message : undefined,
      ),
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: mapGatewayErrorStatus(code),
    };
  }
}

const FIRST_CHUNK_TIMEOUT_MS = 30_000;

// Read the provider stream's first chunk, racing a timeout so a provider that
// 200s but never sends data falls back instead of hanging the request.
async function readFirstChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Provider stream timed out before first byte.")),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// Re-emit the already-read first chunk, then pump the rest from the same reader
// (the web stream is locked once getReader() is called, so Readable.fromWeb can
// no longer be used). Backpressure-aware; cancels the reader if the consumer closes.
function createReadaheadStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstValue: Uint8Array,
): Readable {
  async function* pump(): AsyncGenerator<Buffer> {
    yield Buffer.from(firstValue);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value) {
          yield Buffer.from(value);
        }
      }
    } finally {
      // Consumer closed/destroyed (or stream ended) — release the upstream reader.
      await reader.cancel().catch(() => undefined);
    }
  }
  return Readable.from(pump());
}

export function wrapProviderStreamWithActivityCompletion(
  source: Readable,
  input: {
    collectChunk?: (chunk: Buffer | Uint8Array | string) => void;
    completeActivity: (completion: { statusCode: number }) => Promise<void>;
    errorStatusCode?: number;
    statusCode: number;
  },
): Readable {
  const output = new PassThrough();
  let settled = false;

  source.on("data", (chunk) => {
    input.collectChunk?.(chunk);
    output.write(chunk);
  });
  source.once("end", () => {
    void settleActivity(input.statusCode)
      .catch(() => undefined)
      .finally(() => output.end());
  });
  source.once("error", (error) => {
    void settleActivity(input.errorStatusCode ?? 502)
      .catch(() => undefined)
      .finally(() => {
        output.destroy(error instanceof Error ? error : new Error("Provider stream failed."));
      });
  });
  source.once("close", () => {
    if (settled || source.readableEnded) {
      return;
    }
    void settleActivity(input.errorStatusCode ?? 499)
      .catch(() => undefined)
      .finally(() => output.destroy());
  });

  async function settleActivity(statusCode: number): Promise<void> {
    if (settled) {
      return;
    }
    settled = true;
    await input.completeActivity({ statusCode });
  }

  return output;
}

export function wrapProviderStreamWithErrorRecording(
  source: Readable,
  input: {
    recordRuntimeError: (error: GatewayRuntimeStreamError) => Promise<void>;
  },
): Readable {
  const output = new PassThrough();
  let recorded = false;

  source.on("error", (error) => {
    const runtimeError: GatewayRuntimeStreamError = {
      errorCode: "provider_stream_error",
      errorMessage: error instanceof Error ? error.message : "Provider stream failed.",
    };

    const record = recorded
      ? Promise.resolve()
      : input.recordRuntimeError(runtimeError).catch(() => undefined);
    recorded = true;
    void record.finally(() => {
      output.destroy(error instanceof Error ? error : new Error(runtimeError.errorMessage));
    });
  });
  source.pipe(output);

  return output;
}

/**
 * Records provider/model health when the stream errors AFTER at least one data chunk has
 * been received (bytesSent). A started-then-broken stream is a hard failure that cannot
 * be retried transparently, so we persist the health event via request_path trigger.
 * Health recording is best-effort (.catch(()=>undefined)) and must not crash the stream.
 */
function wrapProviderStreamWithMidStreamHealthRecording(
  source: Readable,
  input: {
    candidate: FallbackChainCandidate;
    databaseUrl: string;
  },
): Readable {
  let bytesSent = false;

  source.on("data", () => {
    bytesSent = true;
  });

  source.once("error", (error) => {
    const errorMessage = error instanceof Error ? error.message : "Provider stream failed.";
    const healthStatus = classifyProviderFailureStatus({
      errorCode: "provider_stream_error",
      errorMessage,
      // statusCode undefined → classifyProviderFailureStatus treats as runtime failure
      statusCode: undefined,
    });
    const shared = {
      databaseUrl: input.databaseUrl,
      errorCode: "provider_stream_error",
      errorMessage,
      metadata: { failedBeforeFirstByte: !bytesSent },
      status: healthStatus,
      trigger: "request_path" as const,
    };
    void recordProviderHealthEvent({
      ...shared,
      providerId: input.candidate.providerId,
    }).catch(() => undefined);
    void recordProviderHealthEvent({
      ...shared,
      providerId: input.candidate.providerId,
      providerModelId: input.candidate.providerModelId,
    }).catch(() => undefined);
  });

  return source;
}

function wrapProviderStreamWithBudgetFinalization(
  source: Readable,
  input: {
    databaseUrl: string;
    reservation: GatewayBudgetReservation | undefined;
  },
): Readable {
  let settled = false;
  source.once("end", () => {
    if (settled) {
      return;
    }
    settled = true;
    void finalizeGatewayBudgetReservation(input);
  });
  source.once("error", () => {
    if (settled) {
      return;
    }
    settled = true;
    void releaseGatewayBudgetReservation(input);
  });
  source.once("close", () => {
    if (settled) {
      return;
    }
    settled = true;
    void releaseGatewayBudgetReservation(input);
  });
  return source;
}

function wrapProviderStreamWithConcurrencyRelease(
  source: Readable,
  input: {
    databaseUrl: string;
    lease: GatewayConcurrencyLease | undefined;
  },
): Readable {
  let settled = false;
  const release = () => {
    if (settled) {
      return;
    }
    settled = true;
    void releaseGatewayConcurrency(input);
  };
  source.once("end", release);
  source.once("error", release);
  source.once("close", release);
  return source;
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
      payload: omitUndefined({
        max_tokens: normalized.request.maxOutputTokens,
        messages: normalized.request.messages,
        temperature: normalized.request.temperature,
        tool_choice: normalized.request.toolChoice,
        tools: normalized.request.tools,
      }),
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
      payload: omitUndefined({
        input: normalized.request.input,
        instructions: normalized.request.instructions,
        max_output_tokens: normalized.request.maxOutputTokens,
        store: false,
        temperature: normalized.request.temperature,
      }),
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
    payload: omitUndefined({
      max_tokens: normalized.request.maxOutputTokens,
      metadata: normalized.request.metadata,
      messages: normalized.request.messages,
      service_tier: normalized.request.serviceTier,
      stop_sequences: normalized.request.stopSequences,
      system: normalized.request.system,
      temperature: normalized.request.temperature,
      thinking: normalized.request.thinking,
      tool_choice: normalized.request.toolChoice,
      tools: normalized.request.tools,
      top_k: normalized.request.topK,
      top_p: normalized.request.topP,
    }),
    requestMetadata,
  };
}

async function recordGatewayRuntimeError(input: {
  databaseUrl: string;
  error: GatewayRuntimeStreamError;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    await client.query(
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
        process.env.GATEWAY_INSTANCE_ID?.trim() || "gateway",
        input.error.errorCode,
        input.error.errorMessage,
        JSON.stringify(input.metadata),
      ],
    );
  } finally {
    await client.end();
  }
}

function buildProviderUrl(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/${suffix}`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

export function buildStreamingProviderUrl(input: {
  baseUrl: string;
  pathSuffix: string;
  providerKey: string;
}): string {
  if (input.providerKey === "openai_codex" && input.pathSuffix === "responses") {
    return buildCodexResponsesUrl(input.baseUrl);
  }
  if (input.providerKey === "claude_code" && input.pathSuffix === "messages") {
    return buildClaudeCodeMessagesUrl(input.baseUrl);
  }
  return buildProviderUrl(input.baseUrl, input.pathSuffix);
}

export function buildStreamingProviderRequestBody(input: {
  modelId: string;
  pathSuffix: string;
  payload: Record<string, unknown>;
  providerKey: string;
}): Record<string, unknown> {
  let body = buildProviderRequestBody(input.payload, input.modelId);
  if (input.providerKey === "openai_codex" && input.pathSuffix === "responses") {
    return buildCodexStreamingResponsesBody(body);
  }
  if (input.pathSuffix === "messages") {
    body = omitUnsupportedAnthropicSamplingParameters(body, input.modelId);
  }
  if (input.providerKey === "claude_code" && input.pathSuffix === "messages") {
    return {
      ...body,
      system: withClaudeCodeSystemPrompt(body.system),
    };
  }
  if (shouldRequestStreamingUsage(input)) {
    return {
      ...body,
      stream_options: {
        ...(isRecord(body.stream_options) ? body.stream_options : {}),
        include_usage: true,
      },
    };
  }
  return body;
}

function shouldRequestStreamingUsage(input: { pathSuffix: string; providerKey: string }): boolean {
  return (
    input.pathSuffix === "chat/completions" &&
    (input.providerKey === "openai" ||
      input.providerKey === "google" ||
      input.providerKey === "lmstudio")
  );
}

const codexUnsupportedResponsesParameters = [
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_p",
  "truncation",
];

function buildProviderRequestBody(
  payload: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  return {
    ...payload,
    model: modelId,
    stream: true,
  };
}

function buildCodexStreamingResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of codexUnsupportedResponsesParameters) {
    delete cleaned[key];
  }
  cleaned.input = normalizeCodexResponsesInput(
    cleaned.input as Parameters<typeof normalizeCodexResponsesInput>[0],
  );
  if (typeof cleaned.instructions !== "string" || !cleaned.instructions.trim()) {
    cleaned.instructions = "You are a helpful assistant.";
  }
  return cleaned;
}

export function buildStreamingProviderHeaders(input: {
  apiKey: string;
  headersWithApiKey: (apiKey: string) => Record<string, string>;
  providerKey: string;
}): Record<string, string> {
  if (input.providerKey === "openai_codex") {
    return buildCodexSubscriptionHeaders(input.apiKey);
  }
  if (input.providerKey === "claude_code") {
    return buildClaudeCodeSubscriptionHeaders(input.apiKey);
  }
  const headers = input.headersWithApiKey(input.apiKey);
  if (input.providerKey === "openrouter") {
    return {
      ...headers,
      ...openRouterAttributionHeaders,
    };
  }
  return headers;
}

export function isStreamingProtocolSupportedByProvider(input: {
  pathSuffix: string;
  providerKey: string;
}): boolean {
  if (input.providerKey === "openai_codex") {
    return input.pathSuffix === "responses";
  }
  if (input.providerKey === "claude_code") {
    return input.pathSuffix === "messages";
  }
  return true;
}

async function readProviderErrorBody(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text ? text.slice(0, 2000) : null;
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to read provider error body.";
  }
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

function buildStreamingActivityRoute(input: {
  candidate: FallbackChainCandidate;
  fallbackAttempts: FallbackFailedAttempt[];
  routeDecision: RouteDecision;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: input.fallbackAttempts,
    modelId: input.candidate.modelId,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routeDecision.routePolicyId,
    routeReason: input.routeDecision.routeReason,
    ...(input.candidate.providerApiKeyId
      ? { providerApiKeyId: input.candidate.providerApiKeyId }
      : {}),
    ...(input.candidate.providerApiKeyPrefix
      ? { providerApiKeyPrefix: input.candidate.providerApiKeyPrefix }
      : {}),
  };
}

function createGatewayStreamingErrorBody(
  code: GatewayStreamingErrorCode,
  requestId: string,
  message = streamingErrorMessage(code),
) {
  return {
    error: {
      code,
      message,
    },
    requestId,
  };
}

function classifyStreamingError(message: string): GatewayStreamingErrorCode {
  if (message.includes("No route policy") || message.includes("Route policy")) {
    return "route_not_found";
  }
  if (message.includes("Provider credentials") || message.includes("Provider base URL")) {
    return "provider_credentials_missing";
  }
  return "provider_request_failed";
}

function streamingErrorMessage(code: GatewayStreamingErrorCode): string {
  if (code === "route_not_found") {
    return "No route policy is available for the selected Virtual Model.";
  }
  if (code === "provider_credentials_missing") {
    return "Provider credentials are not configured for the selected route.";
  }
  if (code === "provider_rate_limited") {
    return "Provider rate limit exceeded.";
  }
  if (code === "provider_protocol_unsupported") {
    return "Provider protocol is not supported for this endpoint.";
  }
  if (code === "provider_unavailable") {
    return "No provider is available for the selected route.";
  }
  return "Provider request failed.";
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
