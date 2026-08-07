import { enqueueProviderConnectionProbeJob } from "@llmingress/db/provider-jobs";
import { createLogger } from "@llmingress/logging";
import { isProviderCredentialFailure } from "@llmingress/provider/connectivity";
import { BrokenCircuitError } from "cockatiel";
import { runGatewayBackgroundTask } from "./gateway-background-tasks.ts";
import {
  type GatewayCircuitBreakerRegistry,
  getGatewayCircuitBreakerRegistry,
} from "./gateway-circuit-breaker.ts";
import type { GatewayRouteCandidateSnapshot } from "./gateway-config-reload.ts";
import { GatewayPipelineError, truncateProviderMessage } from "./gateway-errors.ts";
import {
  type GatewayRouteLatencyStats,
  getGatewayRouteLatencyStats,
  type RouteLatencyMetric,
} from "./gateway-route-latency.ts";

const logger = createLogger("gateway");

export type FallbackChainCandidate = GatewayRouteCandidateSnapshot & {
  apiKey: string;
  baseUrl: string;
  providerConnectionId?: string;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerApiKeys?: readonly FallbackProviderApiKey[];
};

export type FallbackProviderApiKey = {
  apiKey: string;
  // Per-token egress base (MiniMax subscription resource_url). When present it
  // overrides the provider-level baseUrl so a rotated key carries its own base.
  baseUrl?: string;
  credentialKind?: "api_key" | "oauth";
  keyPrefix?: string;
  providerConnectionId: string;
  providerApiKeyId?: string;
  providerOAuthId?: string;
};

export type FallbackFailedAttempt = {
  attemptOrder: number;
  durationMs?: number;
  errorCode: string;
  errorMessage: string;
  failedBeforeFirstByte: boolean;
  providerConnectionId?: string;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerModelId: string;
  retryable: boolean;
  statusCode: number | null;
};

export type ProviderFallbackAttemptSuccess = {
  body: unknown;
  headers?: Record<string, string>;
  ok: true;
  statusCode: number;
};

export type ProviderFallbackAttemptResult<TSuccess extends ProviderFallbackAttemptSuccess> =
  | TSuccess
  | (FallbackAttemptErrorLike & { ok: false });

export type ProviderFallbackAttemptsResult<TSuccess extends ProviderFallbackAttemptSuccess> = {
  candidate: FallbackChainCandidate & {
    providerApiKeyId?: string;
    providerApiKeyPrefix?: string;
  };
  durationMs?: number;
  result: TSuccess;
};

export type ExecuteProviderFallbackAttemptsInput<TSuccess extends ProviderFallbackAttemptSuccess> =
  {
    callProvider: (input: {
      candidate: FallbackChainCandidate;
      providerApiKey: FallbackProviderApiKey;
    }) => Promise<ProviderFallbackAttemptResult<TSuccess>>;
    candidates: readonly FallbackChainCandidate[];
    databaseUrl?: string;
    fallbackAttempts: FallbackFailedAttempt[];
    recordFailedAttempt?: (attempt: FallbackFailedAttempt) => Promise<void> | void;
    enqueueConnectionProbe?: typeof enqueueProviderConnectionProbeJob;
    circuitBreakerRegistry?: GatewayCircuitBreakerRegistry;
    requestId?: string;
    /** Which latency pool a successful attempt's duration is sampled into; omitted means no sampling. */
    latencySampleMetric?: RouteLatencyMetric;
    latencyStats?: Pick<GatewayRouteLatencyStats, "recordSample">;
    now?: () => number;
  };

export type FallbackAttemptErrorLike = {
  body?: unknown;
  errorCode: string;
  errorMessage: string;
  failedBeforeFirstByte?: boolean;
  headers?: Record<string, string>;
  retryable?: boolean;
  statusCode: number | null;
};

type FallbackFailureDecision = {
  stopChain: boolean;
  tryNextCredential: boolean;
};

export function buildFallbackExhaustionError(
  lastError: FallbackAttemptErrorLike | undefined,
): GatewayPipelineError {
  if (lastError?.errorCode === "provider_redirect_rejected") {
    return new GatewayPipelineError(
      "provider_redirect_rejected",
      lastError.errorMessage || "Provider returned a redirect. Configure the final provider URL.",
      null,
    );
  }
  const status = lastError?.statusCode ?? null;
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return new GatewayPipelineError(
      "provider_rejected_request",
      truncateProviderMessage(lastError?.errorMessage ?? "Provider rejected the request."),
      status,
    );
  }
  if (status === 429) {
    return new GatewayPipelineError("provider_rate_limited", "Provider rate limit exceeded.", 429);
  }
  return new GatewayPipelineError(
    "provider_request_failed",
    lastError?.errorMessage ?? "All fallback candidates failed.",
    status,
  );
}

export async function executeProviderFallbackAttempts<
  TSuccess extends ProviderFallbackAttemptSuccess,
>(
  input: ExecuteProviderFallbackAttemptsInput<TSuccess>,
): Promise<ProviderFallbackAttemptsResult<TSuccess> | undefined> {
  const now = input.now ?? Date.now;
  let attemptOrder = 0;
  for (const candidate of input.candidates) {
    let stopChain = false;
    for (const providerApiKey of readFallbackProviderApiKeys(candidate)) {
      attemptOrder += 1;
      const registry = input.circuitBreakerRegistry ?? getGatewayCircuitBreakerRegistry();
      // Declared per attempt so cockatiel's own retries (which reinvoke this
      // closure inside registry.executeProviderCall) each overwrite it with
      // their own call's duration — the final value is the last call only,
      // never the retry backoff wait between calls.
      let lastCallDurationMs: number | undefined;
      let result: ProviderFallbackAttemptResult<TSuccess>;
      try {
        result = await registry.executeProviderCall(
          providerApiKey.providerConnectionId,
          async () => {
            const callStartedAtMs = now();
            try {
              return await input.callProvider({ candidate, providerApiKey });
            } finally {
              lastCallDurationMs = Math.max(0, now() - callStartedAtMs);
            }
          },
        );
      } catch (error) {
        if (!(error instanceof BrokenCircuitError)) {
          throw error;
        }
        result = {
          errorCode: "provider_circuit_open",
          errorMessage: `Circuit breaker is open for provider connection ${providerApiKey.providerConnectionId}.`,
          failedBeforeFirstByte: true,
          ok: false,
          statusCode: null,
        };
        // The circuit-open path never invokes the closure above, so
        // lastCallDurationMs stays undefined — nothing to sample or attach.
      }

      if (result.ok) {
        if (input.latencySampleMetric !== undefined && lastCallDurationMs !== undefined) {
          (input.latencyStats ?? getGatewayRouteLatencyStats()).recordSample({
            durationMs: lastCallDurationMs,
            metric: input.latencySampleMetric,
            providerModelId: candidate.providerModelId,
          });
        }
        return {
          candidate: {
            ...candidate,
            apiKey: providerApiKey.apiKey,
            providerConnectionId: providerApiKey.providerConnectionId,
            providerApiKeyId: providerApiKey.providerApiKeyId,
            providerApiKeyPrefix: providerApiKey.keyPrefix,
          },
          durationMs: lastCallDurationMs,
          result,
        };
      }

      logger.error(
        buildGatewayProviderErrorLog({
          attemptOrder,
          candidate,
          requestId: input.requestId,
          result,
        }),
        "gateway provider request failed",
      );

      const failedAttempt = buildFallbackFailedAttempt({
        attemptOrder,
        durationMs: lastCallDurationMs,
        providerApiKey,
        providerModelId: candidate.providerModelId,
        result,
      });
      input.fallbackAttempts.push(failedAttempt);
      await input.recordFailedAttempt?.(failedAttempt);
      await recordCandidateHealthFailure(input, candidate, [failedAttempt]);

      const decision = classifyFallbackFailure(result);
      if (decision.stopChain) {
        stopChain = true;
        break;
      }
      if (!decision.tryNextCredential) {
        break;
      }
    }

    if (stopChain) {
      return undefined;
    }
  }

  return undefined;
}

export function buildGatewayProviderErrorLog(input: {
  attemptOrder: number;
  candidate: FallbackChainCandidate;
  requestId?: string;
  result: FallbackAttemptErrorLike;
}): {
  attemptOrder: number;
  errorCode: string;
  errorMessage: string;
  modelId: string;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  providerResponseBody: unknown;
  providerResponseHeaders: Record<string, string>;
  requestId?: string;
  statusCode: number | null;
} {
  return {
    attemptOrder: input.attemptOrder,
    errorCode: input.result.errorCode,
    errorMessage: input.result.errorMessage,
    modelId: input.candidate.modelId,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    providerResponseBody: input.result.body ?? null,
    providerResponseHeaders: input.result.headers ?? {},
    ...(input.requestId ? { requestId: input.requestId } : {}),
    statusCode: input.result.statusCode,
  };
}

export function buildFallbackFailedAttempt(input: {
  attemptOrder: number;
  durationMs?: number;
  providerApiKey: FallbackProviderApiKey;
  providerModelId: string;
  result: FallbackAttemptErrorLike;
}): FallbackFailedAttempt {
  const { statusCode } = input.result;
  const failedBeforeFirstByte = input.result.failedBeforeFirstByte ?? statusCode === null;
  return {
    attemptOrder: input.attemptOrder,
    durationMs: input.durationMs,
    errorCode: input.result.errorCode,
    errorMessage: input.result.errorMessage,
    failedBeforeFirstByte,
    providerConnectionId: input.providerApiKey.providerConnectionId,
    ...(input.providerApiKey.providerApiKeyId
      ? { providerApiKeyId: input.providerApiKey.providerApiKeyId }
      : {}),
    ...(input.providerApiKey.keyPrefix
      ? { providerApiKeyPrefix: input.providerApiKey.keyPrefix }
      : {}),
    providerModelId: input.providerModelId,
    retryable: isFallbackAttemptRetryable(input.result),
    statusCode,
  };
}

function classifyFallbackFailure(result: FallbackAttemptErrorLike): FallbackFailureDecision {
  if (result.errorCode === "provider_redirect_rejected") {
    return { stopChain: true, tryNextCredential: false };
  }

  if (result.errorCode === "provider_circuit_open") {
    return { stopChain: false, tryNextCredential: true };
  }

  const { statusCode } = result;
  if (statusCode === null) {
    return { stopChain: false, tryNextCredential: false };
  }
  if (statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 429) {
    return { stopChain: false, tryNextCredential: true };
  }
  if (statusCode >= 400 && statusCode < 600) {
    return { stopChain: false, tryNextCredential: false };
  }
  return { stopChain: true, tryNextCredential: false };
}

function isFallbackAttemptRetryable(result: FallbackAttemptErrorLike): boolean {
  return !classifyFallbackFailure(result).stopChain;
}

export function readFallbackProviderApiKeys(
  candidate: FallbackChainCandidate,
): readonly FallbackProviderApiKey[] {
  if (candidate.providerApiKeys && candidate.providerApiKeys.length > 0) {
    return candidate.providerApiKeys;
  }

  return [
    {
      apiKey: candidate.apiKey,
      providerConnectionId:
        candidate.providerConnectionId ?? candidate.providerApiKeyId ?? candidate.providerId,
      ...(candidate.providerApiKeyPrefix ? { keyPrefix: candidate.providerApiKeyPrefix } : {}),
      ...(candidate.providerApiKeyId ? { providerApiKeyId: candidate.providerApiKeyId } : {}),
    },
  ];
}

export async function recordCandidateHealthFailure(
  input: {
    databaseUrl?: string;
    enqueueConnectionProbe?: typeof enqueueProviderConnectionProbeJob;
  },
  candidate: FallbackChainCandidate,
  failedAttempts: FallbackFailedAttempt[],
): Promise<void> {
  const enqueue = input.enqueueConnectionProbe ?? enqueueProviderConnectionProbeJob;
  for (const attempt of failedAttempts) {
    if (
      !attempt.providerConnectionId ||
      !isProviderCredentialFailure({
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        statusCode: attempt.statusCode,
      })
    ) {
      continue;
    }
    runGatewayBackgroundTask({
      message: "gateway provider connection probe enqueue failed",
      metadata: {
        providerConnectionId: attempt.providerConnectionId,
        providerId: candidate.providerId,
      },
      name: "gateway.provider_connection_probe.enqueue",
      task: async () => {
        await enqueue({
          ...(input.databaseUrl ? { databaseUrl: input.databaseUrl } : {}),
          providerConnectionId: attempt.providerConnectionId as string,
          providerId: candidate.providerId,
          source: "gateway_credential_error",
          trigger: "system",
        });
      },
    });
  }
}
