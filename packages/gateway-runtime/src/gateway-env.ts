import { parsePositiveInt } from "@llmingress/util";

export type GatewayEnvironment = Record<string, string | undefined>;

export function gatewayBodyLimitBytes(env: GatewayEnvironment = process.env): number {
  return readNonNegativeIntegerEnv(env, "GATEWAY_BODY_LIMIT_BYTES", 10_485_760);
}

export function gatewayStreamConnectTimeoutMs(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_STREAM_CONNECT_TIMEOUT_MS, 10_000);
}

export function gatewayStreamIdleTimeoutMs(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_STREAM_IDLE_TIMEOUT_MS, 120_000);
}

export function gatewayListenHost(env: GatewayEnvironment = process.env): string {
  return readTrimmedEnv(env.GATEWAY_HOST) ?? "127.0.0.1";
}

export function gatewayDebugRequestMetadata(env: GatewayEnvironment = process.env): boolean {
  return env.GATEWAY_DEBUG_REQUEST_METADATA === "true";
}

export function gatewayCorsAllowedOrigins(
  env: GatewayEnvironment = process.env,
): string | undefined {
  return env.GATEWAY_CORS_ALLOWED_ORIGINS;
}

export function gatewayConfigNotifications(env: GatewayEnvironment = process.env): boolean {
  return readBooleanEnv(env, "GATEWAY_CONFIG_NOTIFICATIONS", true);
}

export function gatewayConfigReconcileIntervalMs(env: GatewayEnvironment = process.env): number {
  return readNonNegativeIntegerEnv(env, "GATEWAY_CONFIG_RECONCILE_INTERVAL_MS", 30_000);
}

export function gatewayShutdownDrainMs(env: GatewayEnvironment = process.env): number {
  return readNonNegativeIntegerEnv(env, "GATEWAY_SHUTDOWN_DRAIN_MS", 10_000);
}

export function gatewayReadinessTimeoutMs(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_READINESS_TIMEOUT_MS, 1_000);
}

export function gatewayBreakerEnabled(env: GatewayEnvironment = process.env): boolean {
  return readBooleanEnv(env, "GATEWAY_BREAKER_ENABLED", true);
}

export function gatewayBreakerErrorThresholdPercent(env: GatewayEnvironment = process.env): number {
  // cockatiel's SamplingBreaker requires threshold ∈ (0, 1) exclusive, so the
  // percent must stay within 1..99 or breaker construction throws a RangeError.
  return Math.min(99, parsePositiveInt(env.GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT, 50));
}

export function gatewayBreakerWindowMs(env: GatewayEnvironment = process.env): number {
  // Sub-second windows make SamplingBreaker's bucket size round to zero and void
  // the volume gate, so the window is floored at one second.
  return Math.max(1_000, parsePositiveInt(env.GATEWAY_BREAKER_WINDOW_MS, 60_000));
}

export function gatewayBreakerMinRequests(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_BREAKER_MIN_REQUESTS, 5);
}

export function gatewayBreakerHalfOpenAfterMs(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_BREAKER_HALF_OPEN_AFTER_MS, 30_000);
}

export function gatewayBreakerHalfOpenCalls(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_BREAKER_HALF_OPEN_CALLS, 3);
}

export function gatewayProviderRetries(env: GatewayEnvironment = process.env): number {
  return readNonNegativeIntegerEnv(env, "GATEWAY_PROVIDER_RETRIES", 2);
}

export function gatewayProviderRetryInitialDelayMs(env: GatewayEnvironment = process.env): number {
  return parsePositiveInt(env.GATEWAY_PROVIDER_RETRY_INITIAL_DELAY_MS, 200);
}

export function gatewayHealthSummaryCacheTtlMs(env: GatewayEnvironment = process.env): number {
  return readNonNegativeIntegerEnv(env, "GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", 5_000);
}

function readTrimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readBooleanEnv(
  env: GatewayEnvironment,
  name: keyof GatewayEnvironment,
  fallback: boolean,
): boolean {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  return value !== "false";
}

function readNonNegativeIntegerEnv(
  env: GatewayEnvironment,
  name: keyof GatewayEnvironment,
  fallback: number,
): number {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${String(name)} must be a non-negative integer.`);
  }
  return parsed;
}
