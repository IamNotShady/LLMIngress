import { BrokenCircuitError } from "cockatiel";
import { describe, expect, it, vi } from "vitest";
import type { GatewayCircuitBreakerRegistry } from "../../packages/gateway-runtime/src/gateway-circuit-breaker";
import type { GatewayRouteCandidateSnapshot } from "../../packages/gateway-runtime/src/gateway-config-reload";
import {
  executeProviderFallbackAttempts,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
} from "../../packages/gateway-runtime/src/gateway-fallback-chain";

describe("gateway fallback chain latency sampling", () => {
  it("records one sample per successful attempt with the requested metric", async () => {
    const recordSample = vi.fn();
    const fallbackAttempts: FallbackFailedAttempt[] = [];

    const result = await executeProviderFallbackAttempts({
      callProvider: async () => ({ body: { ok: true }, ok: true as const, statusCode: 200 }),
      candidates: [latencyFallbackCandidate()],
      circuitBreakerRegistry: noRetryRegistry(),
      fallbackAttempts,
      latencySampleMetric: "total",
      latencyStats: { recordSample },
      now: sequenceNow([1_000, 1_120]),
    });

    expect(result?.durationMs).toBe(120);
    expect(recordSample).toHaveBeenCalledOnce();
    expect(recordSample).toHaveBeenCalledWith({
      durationMs: 120,
      metric: "total",
      providerModelId: "pm-latency-1",
    });
  });

  it("attaches duration to failed attempts but records no sample", async () => {
    const recordSample = vi.fn();
    const fallbackAttempts: FallbackFailedAttempt[] = [];

    const result = await executeProviderFallbackAttempts({
      callProvider: async () => ({
        errorCode: "provider_request_failed",
        errorMessage: "boom",
        ok: false as const,
        statusCode: 500,
      }),
      candidates: [latencyFallbackCandidate()],
      // A no-retry registry isolates single-attempt duration attachment; the
      // interaction with cockatiel's own retries is covered separately below.
      circuitBreakerRegistry: noRetryRegistry(),
      fallbackAttempts,
      latencySampleMetric: "total",
      latencyStats: { recordSample },
      now: sequenceNow([2_000, 2_075]),
    });

    expect(result).toBeUndefined();
    expect(fallbackAttempts).toHaveLength(1);
    expect(fallbackAttempts[0]?.durationMs).toBe(75);
    expect(recordSample).not.toHaveBeenCalled();
  });

  it("skips sampling for circuit-open pseudo attempts", async () => {
    const recordSample = vi.fn();
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const openRegistry: GatewayCircuitBreakerRegistry = {
      executeProviderCall: async () => {
        throw new BrokenCircuitError("circuit open");
      },
      shouldSkipConnection: () => true,
    };

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async () => ({ body: {}, ok: true as const, statusCode: 200 })),
      candidates: [latencyFallbackCandidate()],
      circuitBreakerRegistry: openRegistry,
      fallbackAttempts,
      latencySampleMetric: "total",
      latencyStats: { recordSample },
      now: sequenceNow([3_000, 3_050]),
    });

    expect(result).toBeUndefined();
    expect(fallbackAttempts).toHaveLength(1);
    expect(fallbackAttempts[0]?.durationMs).toBeUndefined();
    expect(recordSample).not.toHaveBeenCalled();
  });

  it("excludes retry backoff from the sample", async () => {
    const recordSample = vi.fn();
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    let callCount = 0;
    // Stands in for cockatiel's retry wrap: it invokes the passed closure more
    // than once on a transient failure, with a real backoff wait between calls
    // that never touches `now()` — only each call's own start/end does.
    const retryingRegistry: GatewayCircuitBreakerRegistry = {
      executeProviderCall: async (_providerConnectionId, call) => {
        const first = await call();
        if ((first as { ok: boolean }).ok) {
          return first;
        }
        return await call();
      },
      shouldSkipConnection: () => false,
    };

    const result = await executeProviderFallbackAttempts({
      callProvider: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            errorCode: "provider_request_failed",
            errorMessage: "transient",
            ok: false as const,
            statusCode: 503,
          };
        }
        return { body: { ok: true }, ok: true as const, statusCode: 200 };
      },
      candidates: [latencyFallbackCandidate()],
      circuitBreakerRegistry: retryingRegistry,
      fallbackAttempts,
      latencySampleMetric: "total",
      latencyStats: { recordSample },
      // call 1 (discarded by the retry wrap): starts at 0, runs 50ms.
      // A ~4950ms backoff gap passes with no now() call in between.
      // call 2 (the one that succeeds): starts at 5_000, runs 80ms.
      now: sequenceNow([0, 50, 5_000, 5_080]),
    });

    expect(callCount).toBe(2);
    expect(result?.durationMs).toBe(80);
    expect(fallbackAttempts).toHaveLength(0);
    expect(recordSample).toHaveBeenCalledOnce();
    expect(recordSample).toHaveBeenCalledWith({
      durationMs: 80,
      metric: "total",
      providerModelId: "pm-latency-1",
    });
  });

  it("skips sampling when no metric is requested", async () => {
    const recordSample = vi.fn();
    const fallbackAttempts: FallbackFailedAttempt[] = [];

    const result = await executeProviderFallbackAttempts({
      callProvider: async () => ({ body: { ok: true }, ok: true as const, statusCode: 200 }),
      candidates: [latencyFallbackCandidate()],
      circuitBreakerRegistry: noRetryRegistry(),
      fallbackAttempts,
      latencyStats: { recordSample },
      now: sequenceNow([9_000, 9_010]),
    });

    expect(result?.result.ok).toBe(true);
    expect(recordSample).not.toHaveBeenCalled();
  });
});

// The env-backed default registry retries transient (5xx) failures a
// configurable number of times, which would consume extra scripted `now()`
// values non-deterministically. Tests that only care about single-attempt
// duration attachment pin the registry to exactly one call instead.
function noRetryRegistry(): GatewayCircuitBreakerRegistry {
  return {
    executeProviderCall: (_providerConnectionId, call) => call(),
    shouldSkipConnection: () => false,
  };
}

function sequenceNow(values: number[]): () => number {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("sequenceNow exhausted its scripted values");
    }
    return next;
  };
}

function latencyFallbackCandidate(
  overrides: Partial<GatewayRouteCandidateSnapshot & FallbackChainCandidate> = {},
): FallbackChainCandidate {
  return {
    apiKey: "fallback-key",
    baseUrl: "http://provider.test/v1",
    candidateOrder: 1,
    displayName: "Latency Model",
    modelId: "fake-model",
    price: {
      modelId: "fake-model",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: "provider-latency-1",
    providerKey: "openai",
    providerModelId: "pm-latency-1",
    weight: null,
    ...overrides,
  };
}
