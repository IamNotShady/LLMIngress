import type { PostgresQueryClient } from "@llmingress/db/client";
import { describe, expect, it } from "vitest";
import {
  gatewayLeastTimeAlphaPercent,
  gatewayLeastTimeExplorePercent,
  gatewayLeastTimeFlushIntervalMs,
  gatewayLeastTimeMinSamples,
  gatewayLeastTimeOutlierClampFactor,
  gatewayLeastTimeStaleAfterMs,
  gatewayLeastTimeTieBucketMs,
} from "../../packages/gateway-runtime/src/gateway-env";
import {
  createGatewayRouteLatencyStats,
  type GatewayRouteLatencyConfig,
  getGatewayRouteLatencyStats,
  readGatewayRouteLatencyConfig,
  resetGatewayRouteLatencyStatsForTests,
} from "../../packages/gateway-runtime/src/gateway-route-latency";

type RecordedQuery = { params: unknown[] | undefined; sql: string };

function testConfig(overrides: Partial<GatewayRouteLatencyConfig> = {}): GatewayRouteLatencyConfig {
  return {
    alphaPercent: 20,
    explorePercent: 10,
    flushIntervalMs: 0,
    minSamples: 5,
    outlierClampFactor: 3,
    staleAfterMs: 1_800_000,
    tieBucketMs: 50,
    ...overrides,
  };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("gateway route latency env", () => {
  it("reads least_time configuration with defaults and overrides, including zero-valued overrides", () => {
    expect(gatewayLeastTimeAlphaPercent({})).toBe(20);
    expect(gatewayLeastTimeAlphaPercent({ GATEWAY_LEAST_TIME_ALPHA_PERCENT: "35" })).toBe(35);

    expect(gatewayLeastTimeExplorePercent({})).toBe(10);
    expect(gatewayLeastTimeExplorePercent({ GATEWAY_LEAST_TIME_EXPLORE_PERCENT: "0" })).toBe(0);
    expect(gatewayLeastTimeExplorePercent({ GATEWAY_LEAST_TIME_EXPLORE_PERCENT: "100" })).toBe(100);

    expect(gatewayLeastTimeFlushIntervalMs({})).toBe(10_000);
    expect(gatewayLeastTimeFlushIntervalMs({ GATEWAY_LEAST_TIME_FLUSH_INTERVAL_MS: "0" })).toBe(0);
    expect(
      gatewayLeastTimeFlushIntervalMs({ GATEWAY_LEAST_TIME_FLUSH_INTERVAL_MS: "200" }),
    ).toBe(200);

    expect(gatewayLeastTimeMinSamples({})).toBe(5);
    expect(gatewayLeastTimeMinSamples({ GATEWAY_LEAST_TIME_MIN_SAMPLES: "1" })).toBe(1);

    expect(gatewayLeastTimeOutlierClampFactor({})).toBe(3);
    expect(
      gatewayLeastTimeOutlierClampFactor({ GATEWAY_LEAST_TIME_OUTLIER_CLAMP_FACTOR: "5" }),
    ).toBe(5);

    expect(gatewayLeastTimeStaleAfterMs({})).toBe(1_800_000);
    expect(gatewayLeastTimeStaleAfterMs({ GATEWAY_LEAST_TIME_STALE_AFTER_MS: "60000" })).toBe(
      60_000,
    );

    expect(gatewayLeastTimeTieBucketMs({})).toBe(50);
    expect(gatewayLeastTimeTieBucketMs({ GATEWAY_LEAST_TIME_TIE_BUCKET_MS: "0" })).toBe(0);
    expect(gatewayLeastTimeTieBucketMs({ GATEWAY_LEAST_TIME_TIE_BUCKET_MS: "10" })).toBe(10);
  });

  it("aggregates the seven readers into one config object", () => {
    expect(
      readGatewayRouteLatencyConfig({
        GATEWAY_LEAST_TIME_ALPHA_PERCENT: "15",
        GATEWAY_LEAST_TIME_EXPLORE_PERCENT: "0",
        GATEWAY_LEAST_TIME_FLUSH_INTERVAL_MS: "500",
        GATEWAY_LEAST_TIME_MIN_SAMPLES: "2",
        GATEWAY_LEAST_TIME_OUTLIER_CLAMP_FACTOR: "4",
        GATEWAY_LEAST_TIME_STALE_AFTER_MS: "9000",
        GATEWAY_LEAST_TIME_TIE_BUCKET_MS: "0",
      }),
    ).toEqual({
      alphaPercent: 15,
      explorePercent: 0,
      flushIntervalMs: 500,
      minSamples: 2,
      outlierClampFactor: 4,
      staleAfterMs: 9_000,
      tieBucketMs: 0,
    });
  });
});

describe("gateway route latency stats", () => {
  it("seeds first sample as the ewma itself", () => {
    const stats = createGatewayRouteLatencyStats({ config: testConfig(), now: () => 1_000 });
    stats.recordSample({ durationMs: 250, metric: "total", providerModelId: "pm-1" });

    expect(stats.buildRouteLatencySnapshot("total").samples.get("pm-1")).toEqual({
      ewmaMs: 250,
      lastSampleAtMs: 1_000,
      sampleCount: 1,
    });
  });

  it("decays subsequent samples with alpha and clamps outliers", () => {
    const stats = createGatewayRouteLatencyStats({
      config: testConfig({ alphaPercent: 20, outlierClampFactor: 3 }),
      now: () => 2_000,
    });
    stats.recordSample({ durationMs: 100, metric: "total", providerModelId: "pm-1" });
    stats.recordSample({ durationMs: 10_000, metric: "total", providerModelId: "pm-1" });

    // clamp = min(10000, 100 * 3) = 300; ewma = 0.2 * 300 + 0.8 * 100 = 140
    const decayed = stats.buildRouteLatencySnapshot("total").samples.get("pm-1");
    expect(decayed?.ewmaMs).toBeCloseTo(140);
    expect(decayed?.sampleCount).toBe(2);

    // A sample faster than the current ewma must never be clamped.
    stats.recordSample({ durationMs: 50, metric: "total", providerModelId: "pm-1" });
    // clamp = min(50, 140 * 3) = 50 (no truncation); ewma = 0.2*50 + 0.8*140 = 122
    const fast = stats.buildRouteLatencySnapshot("total").samples.get("pm-1");
    expect(fast?.ewmaMs).toBeCloseTo(122);
    expect(fast?.sampleCount).toBe(3);
  });

  it("separates ttfb and total metric pools", () => {
    const stats = createGatewayRouteLatencyStats({ config: testConfig(), now: () => 1_000 });
    stats.recordSample({ durationMs: 100, metric: "ttfb", providerModelId: "pm-1" });
    stats.recordSample({ durationMs: 500, metric: "total", providerModelId: "pm-1" });

    const ttfbSnapshot = stats.buildRouteLatencySnapshot("ttfb");
    const totalSnapshot = stats.buildRouteLatencySnapshot("total");
    expect(ttfbSnapshot.samples.get("pm-1")?.ewmaMs).toBe(100);
    expect(totalSnapshot.samples.get("pm-1")?.ewmaMs).toBe(500);
    expect(ttfbSnapshot.samples.size).toBe(1);
    expect(totalSnapshot.samples.size).toBe(1);
  });

  it("snapshot carries configured thresholds", () => {
    const stats = createGatewayRouteLatencyStats({
      config: testConfig({ explorePercent: 25, minSamples: 7, staleAfterMs: 999, tieBucketMs: 13 }),
      now: () => 42,
    });

    expect(stats.buildRouteLatencySnapshot("total")).toMatchObject({
      exploreRatio: 0.25,
      minSamples: 7,
      nowMs: 42,
      staleAfterMs: 999,
      tieBucketMs: 13,
    });
  });

  it("flushes only dirty entries and reseeds on start", async () => {
    const calls: RecordedQuery[] = [];
    const queryClient: PostgresQueryClient = {
      query: async (sql, params) => {
        calls.push({ params: params ? [...params] : undefined, sql });
        return { rows: [] };
      },
    };
    const stats = createGatewayRouteLatencyStats({
      config: testConfig(),
      now: () => 5_000,
      queryClient,
    });
    stats.recordSample({ durationMs: 120, metric: "ttfb", providerModelId: "pm-1" });

    await stats.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("insert into route_latency_stats");
    expect(calls[0]?.sql).toContain("on conflict");
    expect(calls[0]?.params).toEqual(["pm-1", "ttfb", 120, 1, new Date(5_000).toISOString()]);

    // No new dirty entries: a second flush must not issue another query.
    await stats.flush();
    expect(calls).toHaveLength(1);

    // A fresh instance reseeds its pool from the database on start().
    const seedQueryClient: PostgresQueryClient = {
      query: async (sql) => {
        if (sql.trim().toLowerCase().startsWith("select")) {
          return {
            rows: [
              {
                ewmaMs: "120",
                lastSampleAt: new Date(5_000).toISOString(),
                metric: "ttfb",
                providerModelId: "pm-1",
                sampleCount: "1",
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const seededStats = createGatewayRouteLatencyStats({
      config: testConfig(),
      queryClient: seedQueryClient,
    });
    await seededStats.start();
    expect(seededStats.buildRouteLatencySnapshot("ttfb").samples.get("pm-1")).toMatchObject({
      ewmaMs: 120,
      sampleCount: 1,
    });
  });

  it("survives a failing flush and re-dirties the batch", async () => {
    let callCount = 0;
    const calls: RecordedQuery[] = [];
    const queryClient: PostgresQueryClient = {
      query: async (sql, params) => {
        callCount += 1;
        calls.push({ params: params ? [...params] : undefined, sql });
        if (callCount === 1) {
          throw new Error("connection reset");
        }
        return { rows: [] };
      },
    };
    const stats = createGatewayRouteLatencyStats({
      config: testConfig(),
      now: () => 1_000,
      queryClient,
    });
    stats.recordSample({ durationMs: 80, metric: "total", providerModelId: "pm-1" });

    await expect(stats.flush()).resolves.toBeUndefined();
    expect(callCount).toBe(1);

    // The failed batch's key was put back into dirty, so the next flush retries it.
    await stats.flush();
    expect(callCount).toBe(2);
    expect(calls[0]?.params).toEqual(calls[1]?.params);
  });

  it("coalesces overlapping flushes into the in-flight one", async () => {
    let resolveQuery: (() => void) | undefined;
    let callCount = 0;
    const queryClient: PostgresQueryClient = {
      query: async () => {
        callCount += 1;
        await new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        return { rows: [] };
      },
    };
    const stats = createGatewayRouteLatencyStats({
      config: testConfig(),
      now: () => 1_000,
      queryClient,
    });
    stats.recordSample({ durationMs: 80, metric: "total", providerModelId: "pm-1" });

    const first = stats.flush();
    const second = stats.flush();
    expect(second).toBe(first);
    expect(callCount).toBe(1);

    resolveQuery?.();
    await first;
  });

  it("stop drains the in-flight flush and the samples recorded during it", async () => {
    const resolvers: Array<() => void> = [];
    const calls: RecordedQuery[] = [];
    const queryClient: PostgresQueryClient = {
      query: async (sql, params) => {
        calls.push({ params: params ? [...params] : undefined, sql });
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        return { rows: [] };
      },
    };
    const stats = createGatewayRouteLatencyStats({
      config: testConfig(),
      now: () => 1_000,
      queryClient,
    });
    stats.recordSample({ durationMs: 80, metric: "total", providerModelId: "pm-1" });

    const inFlight = stats.flush();
    expect(calls).toHaveLength(1);

    // A new sample lands while the first batch is still in flight; the flush
    // that produced `inFlight` already cleared `dirty`, so this re-dirties pm-2.
    stats.recordSample({ durationMs: 90, metric: "total", providerModelId: "pm-2" });

    const stopped = stats.stop();
    resolvers[0]?.();
    await inFlight;
    await flushMicrotasks();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.params?.[0]).toBe("pm-2");

    resolvers[1]?.();
    await stopped;
  });

  it("keeps a handed-out snapshot immutable under later samples", () => {
    const stats = createGatewayRouteLatencyStats({ config: testConfig(), now: () => 1_000 });
    stats.recordSample({ durationMs: 100, metric: "total", providerModelId: "pm-1" });
    const snapshot = stats.buildRouteLatencySnapshot("total");
    const before = snapshot.samples.get("pm-1");

    stats.recordSample({ durationMs: 900, metric: "total", providerModelId: "pm-1" });

    expect(snapshot.samples.get("pm-1")).toEqual(before);
    expect(snapshot.samples.get("pm-1")?.ewmaMs).toBe(100);
  });

  it("resets between tests", () => {
    const first = getGatewayRouteLatencyStats();
    first.recordSample({ durationMs: 100, metric: "total", providerModelId: "pm-1" });
    expect(first.buildRouteLatencySnapshot("total").samples.size).toBe(1);

    resetGatewayRouteLatencyStatsForTests();

    const second = getGatewayRouteLatencyStats();
    expect(second.buildRouteLatencySnapshot("total").samples.size).toBe(0);

    resetGatewayRouteLatencyStatsForTests();
  });
});
