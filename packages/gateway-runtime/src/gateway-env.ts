export type GatewayEnvironment = Record<string, string | undefined>;

export function gatewayBodyLimitBytes(env: GatewayEnvironment = process.env): number {
  return readNonNegativeIntegerEnv(env, "GATEWAY_BODY_LIMIT_BYTES", 10_485_760);
}

export function gatewayStreamConnectTimeoutMs(env: GatewayEnvironment = process.env): number {
  return readPositiveIntegerValue(env.GATEWAY_STREAM_CONNECT_TIMEOUT_MS, 30_000);
}

export function gatewayStreamIdleTimeoutMs(env: GatewayEnvironment = process.env): number {
  return readPositiveIntegerValue(env.GATEWAY_STREAM_IDLE_TIMEOUT_MS, 120_000);
}

export function gatewayBudgetReservationTtlSeconds(env: GatewayEnvironment = process.env): number {
  return readPositiveIntegerValue(env.GATEWAY_BUDGET_RESERVATION_TTL_SECONDS, 1_800);
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
  return readPositiveIntegerValue(env.GATEWAY_READINESS_TIMEOUT_MS, 1_000);
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

function readPositiveIntegerValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
