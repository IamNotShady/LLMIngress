import { describe, expect, it } from "vitest";
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
