import { BrokenCircuitError } from "cockatiel";
import { describe, expect, it } from "vitest";
import {
  createGatewayCircuitBreakerRegistry,
  type GatewayCircuitBreakerConfig,
  type GatewayCircuitBreakerRegistry,
} from "../../packages/gateway-runtime/src/gateway-circuit-breaker";
import {
  gatewayBreakerEnabled,
  gatewayBreakerErrorThresholdPercent,
  gatewayBreakerHalfOpenAfterMs,
  gatewayBreakerHalfOpenCalls,
  gatewayBreakerMinRequests,
  gatewayBreakerWindowMs,
  gatewayHealthSummaryCacheTtlMs,
  gatewayProviderRetries,
  gatewayProviderRetryInitialDelayMs,
  gatewayStreamConnectTimeoutMs,
} from "../../packages/gateway-runtime/src/gateway-env";

describe("gateway circuit breaker env", () => {
  it("reads breaker and retry configuration with defaults and overrides", () => {
    expect(gatewayBreakerEnabled({})).toBe(true);
    expect(gatewayBreakerEnabled({ GATEWAY_BREAKER_ENABLED: "false" })).toBe(false);
    expect(gatewayBreakerErrorThresholdPercent({})).toBe(50);
    expect(
      gatewayBreakerErrorThresholdPercent({ GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT: "20" }),
    ).toBe(20);
    expect(gatewayBreakerWindowMs({})).toBe(60_000);
    expect(gatewayBreakerWindowMs({ GATEWAY_BREAKER_WINDOW_MS: "1000" })).toBe(1_000);
    expect(gatewayBreakerMinRequests({})).toBe(5);
    expect(gatewayBreakerMinRequests({ GATEWAY_BREAKER_MIN_REQUESTS: "3" })).toBe(3);
    expect(gatewayBreakerHalfOpenAfterMs({})).toBe(30_000);
    expect(gatewayBreakerHalfOpenAfterMs({ GATEWAY_BREAKER_HALF_OPEN_AFTER_MS: "1500" })).toBe(
      1_500,
    );
    expect(gatewayBreakerHalfOpenCalls({})).toBe(3);
    expect(gatewayBreakerHalfOpenCalls({ GATEWAY_BREAKER_HALF_OPEN_CALLS: "1" })).toBe(1);
    expect(gatewayProviderRetries({})).toBe(2);
    expect(gatewayProviderRetries({ GATEWAY_PROVIDER_RETRIES: "0" })).toBe(0);
    expect(gatewayProviderRetryInitialDelayMs({})).toBe(200);
    expect(
      gatewayProviderRetryInitialDelayMs({ GATEWAY_PROVIDER_RETRY_INITIAL_DELAY_MS: "10" }),
    ).toBe(10);
    expect(gatewayHealthSummaryCacheTtlMs({})).toBe(5_000);
    expect(gatewayHealthSummaryCacheTtlMs({ GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS: "0" })).toBe(0);
  });

  it("keeps the streaming connect timeout default at ten seconds", () => {
    expect(gatewayStreamConnectTimeoutMs({})).toBe(10_000);
    expect(gatewayStreamConnectTimeoutMs({ GATEWAY_STREAM_CONNECT_TIMEOUT_MS: "30000" })).toBe(
      30_000,
    );
  });
});

describe("gateway circuit breaker registry", () => {
  it("opens after the error percentage threshold within the window and skips the connection", async () => {
    const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });

    await tripBreaker(registry, "conn-1");

    expect(registry.shouldSkipConnection("conn-1")).toBe(true);
    expect(registry.shouldSkipConnection("conn-other")).toBe(false);
    await expect(
      registry.executeProviderCall("conn-1", async () => ({ ok: true as const, statusCode: 200 })),
    ).rejects.toBeInstanceOf(BrokenCircuitError);
  });

  it("counts credential, quota, server, and network failures alike", async () => {
    const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
    for (const statusCode of [401, 429, 500, null]) {
      try {
        await registry.executeProviderCall("conn-mixed", async () => ({
          ok: false as const,
          statusCode,
        }));
      } catch (error) {
        expect(error).toBeInstanceOf(BrokenCircuitError);
      }
    }
    expect(registry.shouldSkipConnection("conn-mixed")).toBe(true);
  });

  it("requires the minimum request volume in the window before opening", async () => {
    const registry = createGatewayCircuitBreakerRegistry({
      config: breakerTestConfig({ minRequests: 3 }),
    });
    for (let index = 0; index < 2; index += 1) {
      await registry.executeProviderCall("conn-volume", async () => ({
        ok: false as const,
        statusCode: 503,
      }));
    }
    expect(registry.shouldSkipConnection("conn-volume")).toBe(false);
    await registry.executeProviderCall("conn-volume", async () => ({
      ok: false as const,
      statusCode: 503,
    }));
    expect(registry.shouldSkipConnection("conn-volume")).toBe(true);
  });

  it("half-open trial closes on success and reopens on failure", async () => {
    const registry = createGatewayCircuitBreakerRegistry({
      config: breakerTestConfig({ halfOpenAfterMs: 50, halfOpenCalls: 1 }),
    });

    await tripBreaker(registry, "conn-trial");
    expect(registry.shouldSkipConnection("conn-trial")).toBe(true);

    await sleep(80);
    expect(registry.shouldSkipConnection("conn-trial")).toBe(false);
    const trial = await registry.executeProviderCall("conn-trial", async () => ({
      ok: true as const,
      statusCode: 200,
    }));
    expect(trial.ok).toBe(true);
    expect(registry.shouldSkipConnection("conn-trial")).toBe(false);

    await tripBreaker(registry, "conn-trial");
    await sleep(80);
    const failedTrial = await registry.executeProviderCall("conn-trial", async () => ({
      ok: false as const,
      statusCode: 503,
    }));
    expect(failedTrial.ok).toBe(false);
    expect(registry.shouldSkipConnection("conn-trial")).toBe(true);
  });

  it("retries transient failures on the same connection and returns the final result", async () => {
    const registry = createGatewayCircuitBreakerRegistry({
      config: breakerTestConfig({ minRequests: 100, retries: 2, retryInitialDelayMs: 1 }),
    });

    let transientCalls = 0;
    const recovered = await registry.executeProviderCall("conn-retry", async () => {
      transientCalls += 1;
      if (transientCalls < 3) {
        return { ok: false as const, statusCode: 503 };
      }
      return { ok: true as const, statusCode: 200 };
    });
    expect(recovered.ok).toBe(true);
    expect(transientCalls).toBe(3);

    let authCalls = 0;
    const rejected = await registry.executeProviderCall("conn-retry", async () => {
      authCalls += 1;
      return { ok: false as const, statusCode: 401 };
    });
    expect(rejected.ok).toBe(false);
    expect(authCalls).toBe(1);

    let midStreamCalls = 0;
    const midStream = await registry.executeProviderCall("conn-retry", async () => {
      midStreamCalls += 1;
      return { failedBeforeFirstByte: false, ok: false as const, statusCode: 503 };
    });
    expect(midStream.ok).toBe(false);
    expect(midStreamCalls).toBe(1);
  });

  it("passes calls through when disabled", async () => {
    const registry = createGatewayCircuitBreakerRegistry({
      config: breakerTestConfig({ enabled: false }),
    });
    for (let index = 0; index < 10; index += 1) {
      const result = await registry.executeProviderCall("conn-off", async () => ({
        ok: false as const,
        statusCode: 503,
      }));
      expect(result.ok).toBe(false);
    }
    expect(registry.shouldSkipConnection("conn-off")).toBe(false);
  });
});

function breakerTestConfig(
  overrides: Partial<GatewayCircuitBreakerConfig> = {},
): GatewayCircuitBreakerConfig {
  return {
    enabled: true,
    errorThresholdPercent: 50,
    halfOpenAfterMs: 60_000,
    halfOpenCalls: 1,
    minRequests: 2,
    retries: 0,
    retryInitialDelayMs: 1,
    windowMs: 1_000,
    ...overrides,
  };
}

async function tripBreaker(
  registry: GatewayCircuitBreakerRegistry,
  providerConnectionId: string,
): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    try {
      await registry.executeProviderCall(providerConnectionId, async () => ({
        ok: false as const,
        statusCode: 503,
      }));
    } catch (error) {
      expect(error).toBeInstanceOf(BrokenCircuitError);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
