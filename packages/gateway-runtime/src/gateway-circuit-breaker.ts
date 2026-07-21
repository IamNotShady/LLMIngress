import { createLogger } from "@llmingress/logging";
import {
  CircuitState,
  circuitBreaker,
  ExponentialBackoff,
  handleWhenResult,
  type IPolicy,
  retry,
  SamplingBreaker,
  wrap,
} from "cockatiel";
import {
  gatewayBreakerEnabled,
  gatewayBreakerErrorThresholdPercent,
  gatewayBreakerHalfOpenAfterMs,
  gatewayBreakerHalfOpenCalls,
  gatewayBreakerMinRequests,
  gatewayBreakerWindowMs,
  gatewayProviderRetries,
  gatewayProviderRetryInitialDelayMs,
} from "./gateway-env.ts";

const logger = createLogger("gateway");

export type GatewayProviderCallResult = {
  failedBeforeFirstByte?: boolean;
  ok: boolean;
  statusCode: number | null;
};

export type GatewayCircuitBreakerConfig = {
  enabled: boolean;
  errorThresholdPercent: number;
  halfOpenAfterMs: number;
  halfOpenCalls: number;
  minRequests: number;
  retries: number;
  retryInitialDelayMs: number;
  windowMs: number;
};

export type GatewayCircuitBreakerRegistry = {
  executeProviderCall: <T extends GatewayProviderCallResult>(
    providerConnectionId: string,
    call: () => Promise<T>,
  ) => Promise<T>;
  shouldSkipConnection: (providerConnectionId: string) => boolean;
};

export function readGatewayCircuitBreakerConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayCircuitBreakerConfig {
  return {
    enabled: gatewayBreakerEnabled(env),
    errorThresholdPercent: gatewayBreakerErrorThresholdPercent(env),
    halfOpenAfterMs: gatewayBreakerHalfOpenAfterMs(env),
    halfOpenCalls: gatewayBreakerHalfOpenCalls(env),
    minRequests: gatewayBreakerMinRequests(env),
    retries: gatewayProviderRetries(env),
    retryInitialDelayMs: gatewayProviderRetryInitialDelayMs(env),
    windowMs: gatewayBreakerWindowMs(env),
  };
}

export function isTransientProviderFailure(result: GatewayProviderCallResult): boolean {
  if (result.ok || result.failedBeforeFirstByte === false) {
    return false;
  }
  return result.statusCode === null || result.statusCode >= 500;
}

type ConnectionBreakerEntry = {
  lastBreakAtMs: number | null;
  policy: IPolicy;
  readState: () => CircuitState;
};

export function createGatewayCircuitBreakerRegistry(
  options: { config?: Partial<GatewayCircuitBreakerConfig>; now?: () => number } = {},
): GatewayCircuitBreakerRegistry {
  const config: GatewayCircuitBreakerConfig = {
    ...readGatewayCircuitBreakerConfig(),
    ...options.config,
  };
  // `now` only shifts shouldSkipConnection's advisory gate; cockatiel's own
  // Open→HalfOpen timing is hard-wired to Date.now, so injected clocks must track it.
  const now = options.now ?? Date.now;

  if (!config.enabled) {
    return {
      executeProviderCall: (_providerConnectionId, call) => call(),
      shouldSkipConnection: () => false,
    };
  }

  const entries = new Map<string, ConnectionBreakerEntry>();

  function entryFor(providerConnectionId: string): ConnectionBreakerEntry {
    const existing = entries.get(providerConnectionId);
    if (existing) {
      return existing;
    }

    const breakerPolicy = circuitBreaker(
      handleWhenResult((result) => isProviderCallFailure(result)),
      {
        breaker: new SamplingBreaker({
          duration: config.windowMs,
          // SamplingBreaker's volume gate is `total >= minimumRps × durationSeconds`,
          // so this derivation makes minRequests an exact per-window request count
          // (windowMs must be a whole-second value ≥ 1000).
          minimumRps: config.minRequests / (config.windowMs / 1000),
          threshold: config.errorThresholdPercent / 100,
        }),
        halfOpenAfter: config.halfOpenAfterMs,
        halfOpenSampling: { calls: config.halfOpenCalls, threshold: 0.5 },
      },
    );
    const entry: ConnectionBreakerEntry = {
      lastBreakAtMs: null,
      policy:
        config.retries > 0
          ? wrap(
              retry(
                handleWhenResult((result) =>
                  isTransientProviderFailure(result as GatewayProviderCallResult),
                ),
                {
                  backoff: new ExponentialBackoff({
                    initialDelay: config.retryInitialDelayMs,
                    maxDelay: 2_000,
                  }),
                  // cockatiel's maxAttempts counts retries after the initial call,
                  // so total calls = retries + 1. Each retry attempt is a separate
                  // breaker sample, so one transiently-failing request can contribute
                  // up to retries + 1 failures toward minRequests.
                  maxAttempts: config.retries,
                },
              ),
              breakerPolicy,
            )
          : breakerPolicy,
      readState: () => breakerPolicy.state,
    };
    breakerPolicy.onBreak(() => {
      entry.lastBreakAtMs = now();
      logger.warn({ providerConnectionId }, "gateway provider connection circuit opened");
    });
    breakerPolicy.onReset(() => {
      entry.lastBreakAtMs = null;
      logger.info({ providerConnectionId }, "gateway provider connection circuit closed");
    });
    breakerPolicy.onHalfOpen(() => {
      logger.info({ providerConnectionId }, "gateway provider connection circuit half-open");
    });
    entries.set(providerConnectionId, entry);
    return entry;
  }

  return {
    executeProviderCall: (providerConnectionId, call) =>
      entryFor(providerConnectionId).policy.execute(call),
    shouldSkipConnection: (providerConnectionId) => {
      const entry = entries.get(providerConnectionId);
      if (!entry || entry.readState() !== CircuitState.Open) {
        return false;
      }
      return entry.lastBreakAtMs !== null && now() < entry.lastBreakAtMs + config.halfOpenAfterMs;
    },
  };
}

function isProviderCallFailure(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

let defaultRegistry: GatewayCircuitBreakerRegistry | null = null;

export function getGatewayCircuitBreakerRegistry(): GatewayCircuitBreakerRegistry {
  defaultRegistry ??= createGatewayCircuitBreakerRegistry();
  return defaultRegistry;
}

export function resetGatewayCircuitBreakerRegistryForTests(): void {
  defaultRegistry = null;
}
