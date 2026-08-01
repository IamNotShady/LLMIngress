import { type PostgresQueryClient, withPooledPostgresClient } from "@llmingress/db/client";
import type { RouteLatencySample, RouteLatencySnapshot } from "@llmingress/domain";
import { createLogger } from "@llmingress/logging";
import {
  type GatewayEnvironment,
  gatewayLeastTimeAlphaPercent,
  gatewayLeastTimeExplorePercent,
  gatewayLeastTimeFlushIntervalMs,
  gatewayLeastTimeMinSamples,
  gatewayLeastTimeOutlierClampFactor,
  gatewayLeastTimeStaleAfterMs,
  gatewayLeastTimeTieBucketMs,
} from "./gateway-env.ts";

const logger = createLogger("gateway");

export type RouteLatencyMetric = "ttfb" | "total";

export type GatewayRouteLatencyConfig = {
  /** EWMA smoothing factor as an integer percent (GATEWAY_LEAST_TIME_ALPHA_PERCENT, default 20). */
  alphaPercent: number;
  /** Share of requests (integer percent) that promote a cold candidate (GATEWAY_LEAST_TIME_EXPLORE_PERCENT, default 10). */
  explorePercent: number;
  /** How often dirty samples are flushed to Postgres; 0 disables the timer (GATEWAY_LEAST_TIME_FLUSH_INTERVAL_MS, default 10000). */
  flushIntervalMs: number;
  /** Samples required before a candidate counts as warm (GATEWAY_LEAST_TIME_MIN_SAMPLES, default 5). */
  minSamples: number;
  /** A sample above ewma * this factor is clamped down before averaging (GATEWAY_LEAST_TIME_OUTLIER_CLAMP_FACTOR, default 3). */
  outlierClampFactor: number;
  /** A sample older than this is treated as cold again (GATEWAY_LEAST_TIME_STALE_AFTER_MS, default 1800000). */
  staleAfterMs: number;
  /** EWMA quantization bucket; 0 disables bucketing (GATEWAY_LEAST_TIME_TIE_BUCKET_MS, default 50). */
  tieBucketMs: number;
};

export function readGatewayRouteLatencyConfig(
  env: GatewayEnvironment = process.env,
): GatewayRouteLatencyConfig {
  return {
    alphaPercent: gatewayLeastTimeAlphaPercent(env),
    explorePercent: gatewayLeastTimeExplorePercent(env),
    flushIntervalMs: gatewayLeastTimeFlushIntervalMs(env),
    minSamples: gatewayLeastTimeMinSamples(env),
    outlierClampFactor: gatewayLeastTimeOutlierClampFactor(env),
    staleAfterMs: gatewayLeastTimeStaleAfterMs(env),
    tieBucketMs: gatewayLeastTimeTieBucketMs(env),
  };
}

type MutableSample = { ewmaMs: number; lastSampleAtMs: number; sampleCount: number };

type RouteLatencyStatsRow = {
  ewmaMs: string | number;
  lastSampleAt: string | Date;
  metric: string;
  providerModelId: string;
  sampleCount: string | number;
};

type RouteLatencyUpsertRow = {
  ewmaMs: number;
  lastSampleAtIso: string;
  metric: RouteLatencyMetric;
  providerModelId: string;
  sampleCount: number;
};

export type GatewayRouteLatencyStats = {
  buildRouteLatencySnapshot: (metric: RouteLatencyMetric) => RouteLatencySnapshot;
  flush: () => Promise<void>;
  recordSample: (input: {
    durationMs: number;
    metric: RouteLatencyMetric;
    providerModelId: string;
  }) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const routeLatencyMetrics: readonly RouteLatencyMetric[] = ["ttfb", "total"];

/**
 * Least-time's live latency cache: one decayed average (EWMA) per provider
 * model, kept in two pools (ttfb / total) so a streaming candidate's
 * first-byte latency never mixes with a JSON candidate's full-call time.
 *
 * All mutation (recordSample, buildRouteLatencySnapshot) is synchronous —
 * Node only interleaves at await/callback boundaries, so a Map read-modify-
 * write with no await in between is safe without locking. Flushing to
 * Postgres is the only async part: it synchronously drains the dirty set
 * into a batch, then awaits the upserts, so newly recorded samples during
 * the flush re-dirty their key and are caught by the next flush (dirty is a
 * Set of keys, not a queue, so this never grows unbounded).
 */
export function createGatewayRouteLatencyStats(options?: {
  config?: GatewayRouteLatencyConfig;
  databaseUrl?: string;
  now?: () => number;
  queryClient?: PostgresQueryClient;
}): GatewayRouteLatencyStats {
  const config = options?.config ?? readGatewayRouteLatencyConfig();
  const now = options?.now ?? Date.now;
  const databaseUrl = options?.databaseUrl;

  // Invariant 8: one Map per metric, so a snapshot walks only its own pool.
  const pools: Record<RouteLatencyMetric, Map<string, MutableSample>> = {
    total: new Map(),
    ttfb: new Map(),
  };
  // Set of `${providerModelId}:${metric}` keys, not a sample queue: its size
  // is bounded by (model count * 2) regardless of request volume.
  const dirty = new Set<string>();
  let flushInFlight: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Invariant 1: purely synchronous, no await inside.
  function recordSample(input: {
    durationMs: number;
    metric: RouteLatencyMetric;
    providerModelId: string;
  }): void {
    const pool = pools[input.metric];
    const current = pool.get(input.providerModelId);
    if (!current) {
      pool.set(input.providerModelId, {
        ewmaMs: input.durationMs,
        lastSampleAtMs: now(),
        sampleCount: 1,
      });
    } else {
      const clamped = Math.min(input.durationMs, current.ewmaMs * config.outlierClampFactor);
      const alpha = config.alphaPercent / 100;
      current.ewmaMs = alpha * clamped + (1 - alpha) * current.ewmaMs;
      current.sampleCount += 1;
      current.lastSampleAtMs = now();
    }
    dirty.add(routeLatencyDirtyKey(input.providerModelId, input.metric));
  }

  // Invariant 1 + 2: synchronous; every sample is copied into a new object so
  // the map handed to domain is a frozen-in-time view (later recordSample
  // calls mutate the internal object, never the copy already handed out).
  function buildRouteLatencySnapshot(metric: RouteLatencyMetric): RouteLatencySnapshot {
    const copied = new Map<string, RouteLatencySample>();
    for (const [providerModelId, sample] of pools[metric]) {
      copied.set(providerModelId, { ...sample });
    }
    return {
      exploreRatio: config.explorePercent / 100,
      minSamples: config.minSamples,
      nowMs: now(),
      samples: copied,
      staleAfterMs: config.staleAfterMs,
      tieBucketMs: config.tieBucketMs,
    };
  }

  function query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    if (options?.queryClient) {
      return options.queryClient.query<T>(sql, params);
    }
    return withPooledPostgresClient(databaseUrl, (client) => client.query<T>(sql, params));
  }

  function materializeRow(key: string): RouteLatencyUpsertRow | undefined {
    const parsed = parseRouteLatencyDirtyKey(key);
    if (!parsed) {
      return undefined;
    }
    const sample = pools[parsed.metric].get(parsed.providerModelId);
    if (!sample) {
      return undefined;
    }
    return {
      ewmaMs: sample.ewmaMs,
      lastSampleAtIso: new Date(sample.lastSampleAtMs).toISOString(),
      metric: parsed.metric,
      providerModelId: parsed.providerModelId,
      sampleCount: sample.sampleCount,
    };
  }

  // Invariant 3 + 4 + 5: dirty is drained into `batch` and every row is
  // materialized from current sample state in one synchronous segment,
  // before the first await. Re-entrant calls while a flush is in flight return that
  // same promise (the plain boolean/Promise guard from
  // gateway-config-reload.ts's reloadInFlight). A failed batch puts its keys
  // back into dirty (Set union, so re-adding is idempotent) and logs a
  // warning instead of throwing — the request hot path never waits on this.
  function flush(): Promise<void> {
    if (flushInFlight) {
      return flushInFlight;
    }
    if (dirty.size === 0) {
      return Promise.resolve();
    }

    const batch = [...dirty];
    dirty.clear();
    const rows = batch
      .map((key) => materializeRow(key))
      .filter((row): row is RouteLatencyUpsertRow => row !== undefined);

    flushInFlight = (async () => {
      try {
        for (const row of rows) {
          await query(
            `
              insert into route_latency_stats (
                provider_model_id, metric, ewma_ms, sample_count, last_sample_at, updated_at
              )
              values ($1, $2, $3, $4, $5, now())
              on conflict (provider_model_id, metric) do update
                 set ewma_ms = excluded.ewma_ms,
                     sample_count = excluded.sample_count,
                     last_sample_at = excluded.last_sample_at,
                     updated_at = now()
            `,
            [row.providerModelId, row.metric, row.ewmaMs, row.sampleCount, row.lastSampleAtIso],
          );
        }
      } catch (error) {
        for (const key of batch) {
          dirty.add(key);
        }
        logger.warn({ err: error }, "route latency flush failed; will retry on the next tick");
      } finally {
        flushInFlight = null;
      }
    })();
    return flushInFlight;
  }

  // Invariant 6: seed runs before listen(), when there is no concurrent
  // traffic yet, so there is nothing to race against. A failed seed just
  // starts the process with an empty cache (cold fallback for every
  // candidate) instead of blocking startup.
  async function seed(): Promise<void> {
    try {
      const result = await query<RouteLatencyStatsRow>(
        `
          select provider_model_id::text as "providerModelId",
                 metric,
                 ewma_ms as "ewmaMs",
                 sample_count as "sampleCount",
                 last_sample_at as "lastSampleAt"
          from route_latency_stats
        `,
      );
      for (const row of result.rows) {
        if (!isRouteLatencyMetric(row.metric)) {
          continue;
        }
        pools[row.metric].set(row.providerModelId, {
          ewmaMs: Number(row.ewmaMs),
          lastSampleAtMs: new Date(row.lastSampleAt).getTime(),
          sampleCount: Number(row.sampleCount),
        });
      }
    } catch (error) {
      logger.warn({ err: error }, "route latency seed failed; starting with an empty cache");
    }
  }

  return {
    buildRouteLatencySnapshot,
    flush,
    recordSample,
    start: async () => {
      await seed();
      // Invariant 10: unref'd so a pending flush timer never keeps the
      // process alive; the callback only *initiates* flush() synchronously.
      if (config.flushIntervalMs > 0) {
        flushTimer = setInterval(() => {
          void flush();
        }, config.flushIntervalMs);
        flushTimer.unref?.();
      }
    },
    stop: async () => {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
      // Invariant 4 + 10: double flush. The first call joins any flush
      // already in flight; the second catches samples recorded while that
      // one was pending (they re-dirtied their key after the batch was cut).
      await flush();
      await flush();
    },
  };
}

let defaultStats: GatewayRouteLatencyStats | null = null;

export function getGatewayRouteLatencyStats(): GatewayRouteLatencyStats {
  defaultStats ??= createGatewayRouteLatencyStats();
  return defaultStats;
}

export function resetGatewayRouteLatencyStatsForTests(): void {
  defaultStats = null;
}

function isRouteLatencyMetric(value: string): value is RouteLatencyMetric {
  return (routeLatencyMetrics as readonly string[]).includes(value);
}

function routeLatencyDirtyKey(providerModelId: string, metric: RouteLatencyMetric): string {
  return `${providerModelId}:${metric}`;
}

function parseRouteLatencyDirtyKey(
  key: string,
): { metric: RouteLatencyMetric; providerModelId: string } | undefined {
  const separatorIndex = key.lastIndexOf(":");
  if (separatorIndex < 0) {
    return undefined;
  }
  const providerModelId = key.slice(0, separatorIndex);
  const metric = key.slice(separatorIndex + 1);
  if (!isRouteLatencyMetric(metric)) {
    return undefined;
  }
  return { metric, providerModelId };
}
