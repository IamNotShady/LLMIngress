import { randomUUID } from "node:crypto";
import { BrokenCircuitError } from "cockatiel";
import { describe, expect, it, vi } from "vitest";
import {
  createTestPostgresFixture,
  runMigrations,
  type TestPostgresFixture,
} from "../../packages/db/src/index";
import { recordProviderConnectionProbeResult } from "../../packages/db/src/provider-health";
import { gatewayBackgroundTasks } from "../../packages/gateway-runtime/src/gateway-background-tasks";
import {
  createGatewayCircuitBreakerRegistry,
  type GatewayCircuitBreakerConfig,
  type GatewayCircuitBreakerRegistry,
} from "../../packages/gateway-runtime/src/gateway-circuit-breaker";
import type { GatewayRouteCandidateSnapshot } from "../../packages/gateway-runtime/src/gateway-config-reload";
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
import {
  executeProviderFallbackAttempts,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  type FallbackProviderApiKey,
} from "../../packages/gateway-runtime/src/gateway-fallback-chain";
import {
  attachGatewayProviderCredentialsLeniently,
  resetGatewayHealthSummaryCacheForTests,
} from "../../packages/gateway-runtime/src/gateway-provider-credentials";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";

describe("gateway circuit breaker env", () => {
  it("reads breaker and retry configuration with defaults and overrides", () => {
    expect(gatewayBreakerEnabled({})).toBe(true);
    expect(gatewayBreakerEnabled({ GATEWAY_BREAKER_ENABLED: "false" })).toBe(false);
    expect(gatewayBreakerErrorThresholdPercent({})).toBe(50);
    expect(
      gatewayBreakerErrorThresholdPercent({ GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT: "100" }),
    ).toBe(99);
    expect(
      gatewayBreakerErrorThresholdPercent({ GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT: "250" }),
    ).toBe(99);
    expect(
      gatewayBreakerErrorThresholdPercent({ GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT: "20" }),
    ).toBe(20);
    expect(gatewayBreakerWindowMs({})).toBe(60_000);
    expect(gatewayBreakerWindowMs({ GATEWAY_BREAKER_WINDOW_MS: "1000" })).toBe(1_000);
    expect(gatewayBreakerWindowMs({ GATEWAY_BREAKER_WINDOW_MS: "500" })).toBe(1_000);
    expect(gatewayBreakerWindowMs({ GATEWAY_BREAKER_WINDOW_MS: "1500" })).toBe(1_500);
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

  it("stays closed while the failure percentage is at or below the threshold", async () => {
    const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
    // SamplingBreaker re-checks `failures > threshold × total` on EVERY failure (not
    // just at the end), so the ratio must stay at/below 50% at each failure. Interleaved
    // S,F,S,F,S,F the failures land at 1/2, 2/4, 3/6 — each exactly at 0.5 × total, and
    // the strict-> comparison keeps the circuit closed at the equality boundary.
    const outcomes: boolean[] = [true, false, true, false, true, false];
    for (const ok of outcomes) {
      await registry.executeProviderCall("conn-ratio", async () =>
        ok ? { ok: true as const, statusCode: 200 } : { ok: false as const, statusCode: 503 },
      );
    }
    expect(registry.shouldSkipConnection("conn-ratio")).toBe(false);
    await registry.executeProviderCall("conn-ratio", async () => ({
      ok: false as const,
      statusCode: 503,
    }));
    // 4 failures of 7 total: 4 > 0.5 × 7 = 3.5 — the ratio finally clears the bar and opens.
    expect(registry.shouldSkipConnection("conn-ratio")).toBe(true);
  });

  it("admits only one half-open trial at a time and queues excess calls behind it", async () => {
    const registry = createGatewayCircuitBreakerRegistry({
      config: breakerTestConfig({ halfOpenAfterMs: 50, halfOpenCalls: 1 }),
    });
    await tripBreaker(registry, "conn-half-open-race");
    await sleep(80);

    let releaseTrial: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTrial = resolve;
    });
    let trialStarted = 0;
    const trialPromise = registry.executeProviderCall("conn-half-open-race", async () => {
      trialStarted += 1;
      await gate;
      return { ok: true as const, statusCode: 200 };
    });
    await sleep(10);

    // With halfOpenCalls=1 only one trial may run; a concurrent call is admitted to the
    // half-open state but held behind the single in-flight trial — its provider callback
    // must not run until the trial resolves.
    let excessStarted = false;
    const excessPromise = registry.executeProviderCall("conn-half-open-race", async () => {
      excessStarted = true;
      return { ok: true as const, statusCode: 200 };
    });
    await sleep(10);
    expect(trialStarted).toBe(1);
    expect(excessStarted).toBe(false);

    releaseTrial();
    const trial = await trialPromise;
    const excess = await excessPromise;
    expect(trial.ok).toBe(true);
    // The trial's success closed the circuit, so the queued call then runs in Closed state.
    expect(excessStarted).toBe(true);
    expect(excess.ok).toBe(true);
    expect(registry.shouldSkipConnection("conn-half-open-race")).toBe(false);
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

describe("gateway circuit breaker fallback integration", () => {
  it("converts an open circuit into a provider_circuit_open attempt and tries the next credential", async () => {
    const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
    await tripBreaker(registry, "open-connection");

    const calls: string[] = [];
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const enqueueConnectionProbe = vi.fn(async () => ({
      jobId: "probe-job",
      queued: true as const,
      reused: false,
    }));

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async ({ providerApiKey }) => {
        calls.push(providerApiKey.keyPrefix ?? "missing");
        return { body: { ok: true }, ok: true, statusCode: 200 };
      }),
      candidates: [
        breakerFallbackCandidate({
          providerApiKeys: [
            breakerProviderKey({ keyPrefix: "open-key", providerConnectionId: "open-connection" }),
            breakerProviderKey({ keyPrefix: "good-key", providerConnectionId: "good-connection" }),
          ],
        }),
      ],
      circuitBreakerRegistry: registry,
      enqueueConnectionProbe,
      fallbackAttempts,
    });
    await gatewayBackgroundTasks.drain({ timeoutMs: 1_000 });

    expect(calls).toEqual(["good-key"]);
    expect(result?.candidate.providerApiKeyPrefix).toBe("good-key");
    expect(fallbackAttempts).toMatchObject([
      {
        attemptOrder: 1,
        errorCode: "provider_circuit_open",
        failedBeforeFirstByte: true,
        providerConnectionId: "open-connection",
        statusCode: null,
      },
    ]);
    expect(enqueueConnectionProbe).not.toHaveBeenCalled();
  });

  it("keeps feeding real failures to the breaker while preserving the credential probe enqueue", async () => {
    const registry = createGatewayCircuitBreakerRegistry({
      config: breakerTestConfig({ minRequests: 100 }),
    });
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const enqueueConnectionProbe = vi.fn(async () => ({
      jobId: "probe-job",
      queued: true as const,
      reused: false,
    }));

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async ({ providerApiKey }) => {
        if (providerApiKey.keyPrefix === "bad-auth") {
          return {
            errorCode: "invalid_api_key",
            errorMessage: "Invalid API key",
            ok: false,
            statusCode: 401,
          };
        }
        return { body: { ok: true }, ok: true, statusCode: 200 };
      }),
      candidates: [
        breakerFallbackCandidate({
          providerApiKeys: [
            breakerProviderKey({ keyPrefix: "bad-auth", providerConnectionId: "bad-connection" }),
            breakerProviderKey({ keyPrefix: "good-auth", providerConnectionId: "good-connection" }),
          ],
        }),
      ],
      circuitBreakerRegistry: registry,
      enqueueConnectionProbe,
      fallbackAttempts,
    });
    await gatewayBackgroundTasks.drain({ timeoutMs: 1_000 });

    expect(result?.candidate.providerApiKeyPrefix).toBe("good-auth");
    expect(enqueueConnectionProbe).toHaveBeenCalledOnce();
    expect(enqueueConnectionProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: "bad-connection",
        source: "gateway_credential_error",
      }),
    );
  });

  it("interleaves a real failure, an open circuit, and a success across one candidate's keys", async () => {
    const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
    await tripBreaker(registry, "interleave-open");

    const calls: string[] = [];
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const enqueueConnectionProbe = vi.fn(async () => ({
      jobId: "probe-job",
      queued: true as const,
      reused: false,
    }));

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async ({ providerApiKey }) => {
        calls.push(providerApiKey.keyPrefix ?? "missing");
        if (providerApiKey.keyPrefix === "first-429") {
          return {
            errorCode: "provider_rate_limited",
            errorMessage: "Provider rate limited",
            ok: false,
            statusCode: 429,
          };
        }
        return { body: { ok: true }, ok: true, statusCode: 200 };
      }),
      candidates: [
        breakerFallbackCandidate({
          providerApiKeys: [
            breakerProviderKey({ keyPrefix: "first-429", providerConnectionId: "interleave-429" }),
            breakerProviderKey({
              keyPrefix: "second-open",
              providerConnectionId: "interleave-open",
            }),
            breakerProviderKey({ keyPrefix: "third-ok", providerConnectionId: "interleave-ok" }),
          ],
        }),
      ],
      circuitBreakerRegistry: registry,
      enqueueConnectionProbe,
      fallbackAttempts,
    });
    await gatewayBackgroundTasks.drain({ timeoutMs: 1_000 });

    // A 429 is credential-class (tryNextCredential), so the chain advances within the
    // candidate: real 429 → open circuit (synthetic provider_circuit_open) → success.
    expect(calls).toEqual(["first-429", "third-ok"]);
    expect(result?.candidate.providerApiKeyPrefix).toBe("third-ok");
    expect(fallbackAttempts).toMatchObject([
      { attemptOrder: 1, providerConnectionId: "interleave-429", statusCode: 429 },
      {
        attemptOrder: 2,
        errorCode: "provider_circuit_open",
        providerConnectionId: "interleave-open",
        statusCode: null,
      },
    ]);
    expect(enqueueConnectionProbe).toHaveBeenCalledOnce();
    expect(enqueueConnectionProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: "interleave-429",
        source: "gateway_credential_error",
      }),
    );
  });
});

function breakerFallbackCandidate(
  overrides: Partial<GatewayRouteCandidateSnapshot & FallbackChainCandidate> = {},
): FallbackChainCandidate {
  return {
    apiKey: "fallback-key",
    baseUrl: "http://provider.test/v1",
    candidateOrder: 1,
    displayName: "Breaker Model",
    modelId: "fake-model",
    price: {
      modelId: "fake-model",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: "provider-breaker-1",
    providerKey: "openai",
    providerModelId: "pm-breaker-1",
    weight: null,
    ...overrides,
  };
}

function breakerProviderKey(
  overrides: Partial<FallbackProviderApiKey> = {},
): FallbackProviderApiKey {
  return {
    apiKey: "fake-provider-key",
    keyPrefix: "fake-key",
    providerConnectionId: "connection-1",
    ...overrides,
  };
}

describe("gateway circuit breaker credential filtering", () => {
  it("filters open-breaker connections in memory before consulting provider health summary", async () => {
    await withBreakerFixture(async (fixture) => {
      const seeded = await seedBreakerProviderWithTwoKeys(fixture);
      const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
      await tripBreaker(registry, seeded.keyOneId);

      const candidates = await attachGatewayProviderCredentialsLeniently({
        candidates: [breakerCredentialCandidate(seeded.providerId)],
        circuitBreakerRegistry: registry,
        databaseUrl: fixture.databaseUrl,
        encryptionKeySource: { kind: "inline", value: "test-master-key" },
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
        seeded.keyTwoId,
      ]);
    });
  });

  it("serves the unhealthy connection set from the TTL cache", async () => {
    await withBreakerFixture(async (fixture) => {
      vi.stubEnv("GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", "60000");
      try {
        resetGatewayHealthSummaryCacheForTests();
        const seeded = await seedBreakerProviderWithTwoKeys(fixture);
        const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
        await recordProviderConnectionProbeResult({
          databaseUrl: fixture.databaseUrl,
          providerConnectionId: seeded.keyTwoId,
          providerId: seeded.providerId,
          status: "unhealthy",
          trigger: "worker_probe",
        });

        const attach = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(seeded.providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixture.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });

        const first = await attach();
        expect(first[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
        ]);

        await fixture.query("delete from provider_health_summary");
        const second = await attach();
        expect(second[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
        ]);

        resetGatewayHealthSummaryCacheForTests();
        const third = await attach();
        expect(third[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
          seeded.keyTwoId,
        ]);
      } finally {
        vi.unstubAllEnvs();
        resetGatewayHealthSummaryCacheForTests();
      }
    });
  });

  it("bypasses the cache when the TTL is zero", async () => {
    await withBreakerFixture(async (fixture) => {
      vi.stubEnv("GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", "0");
      try {
        resetGatewayHealthSummaryCacheForTests();
        const seeded = await seedBreakerProviderWithTwoKeys(fixture);
        const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
        await recordProviderConnectionProbeResult({
          databaseUrl: fixture.databaseUrl,
          providerConnectionId: seeded.keyTwoId,
          providerId: seeded.providerId,
          status: "unhealthy",
          trigger: "worker_probe",
        });
        const attach = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(seeded.providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixture.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });
        const filtered = await attach();
        expect(filtered[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
        ]);
        await fixture.query("delete from provider_health_summary");
        const fresh = await attach();
        expect(fresh[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
          seeded.keyTwoId,
        ]);
      } finally {
        vi.unstubAllEnvs();
        resetGatewayHealthSummaryCacheForTests();
      }
    });
  });

  it("refreshes the unhealthy set from the database after the ttl expires", async () => {
    await withBreakerFixture(async (fixture) => {
      vi.stubEnv("GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", "50");
      try {
        resetGatewayHealthSummaryCacheForTests();
        const seeded = await seedBreakerProviderWithTwoKeys(fixture);
        const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
        await recordProviderConnectionProbeResult({
          databaseUrl: fixture.databaseUrl,
          providerConnectionId: seeded.keyTwoId,
          providerId: seeded.providerId,
          status: "unhealthy",
          trigger: "worker_probe",
        });
        const attach = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(seeded.providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixture.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });
        const filtered = await attach();
        expect(filtered[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
        ]);
        await fixture.query("delete from provider_health_summary");
        await sleep(80);
        const fresh = await attach();
        expect(fresh[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          seeded.keyOneId,
          seeded.keyTwoId,
        ]);
      } finally {
        vi.unstubAllEnvs();
        resetGatewayHealthSummaryCacheForTests();
      }
    });
  });

  it("keys the unhealthy cache by database url so fixtures stay isolated", async () => {
    await withBreakerFixture(async (fixtureA) => {
      vi.stubEnv("GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", "60000");
      const fixtureB = await createTestPostgresFixture({
        databaseNamePrefix: `llmingress_gateway_breaker_${randomUUID().replaceAll("-", "_")}`,
      });
      try {
        await runMigrations({ databaseUrl: fixtureB.databaseUrl });
        resetGatewayHealthSummaryCacheForTests();
        const seededA = await seedBreakerProviderWithTwoKeys(fixtureA);
        const seededB = await seedBreakerProviderWithTwoKeys(fixtureB);
        const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
        await recordProviderConnectionProbeResult({
          databaseUrl: fixtureA.databaseUrl,
          providerConnectionId: seededA.keyTwoId,
          providerId: seededA.providerId,
          status: "unhealthy",
          trigger: "worker_probe",
        });

        const attachA = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(seededA.providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixtureA.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });
        const attachB = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(seededB.providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixtureB.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });

        expect(
          (await attachA())[0]?.providerApiKeys?.map((key) => key.providerConnectionId),
        ).toEqual([seededA.keyOneId]);
        expect(
          (await attachB())[0]?.providerApiKeys?.map((key) => key.providerConnectionId),
        ).toEqual([seededB.keyOneId, seededB.keyTwoId]);

        await fixtureA.query("delete from provider_health_summary");
        expect(
          (await attachA())[0]?.providerApiKeys?.map((key) => key.providerConnectionId),
        ).toEqual([seededA.keyOneId]);
        expect(
          (await attachB())[0]?.providerApiKeys?.map((key) => key.providerConnectionId),
        ).toEqual([seededB.keyOneId, seededB.keyTwoId]);
      } finally {
        vi.unstubAllEnvs();
        resetGatewayHealthSummaryCacheForTests();
        await fixtureB.dispose();
      }
    });
  });

  it("drops a local provider connection once its breaker is open", async () => {
    await withBreakerFixture(async (fixture) => {
      vi.stubEnv("GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", "0");
      try {
        resetGatewayHealthSummaryCacheForTests();
        const providerId = randomUUID();
        await fixture.query(
          `
            insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled)
            values ($1, 'local', 'ollama', null, 'Local Breaker', 'http://provider.test', true)
          `,
          [providerId],
        );
        const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
        const attach = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixture.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });

        const healthy = await attach();
        expect(healthy).toHaveLength(1);
        expect(healthy[0]?.providerApiKeys).toEqual([
          { apiKey: "", providerConnectionId: providerId },
        ]);

        await tripBreaker(registry, providerId);
        // The only candidate's sole local connection is filtered in memory, so the
        // lenient attach surfaces the drop as an unavailable-connection error.
        await expect(attach()).rejects.toMatchObject({
          code: "provider_connection_unavailable",
        });
      } finally {
        vi.unstubAllEnvs();
        resetGatewayHealthSummaryCacheForTests();
      }
    });
  });

  it("filters an open-breaker oauth connection while keeping the healthy subscription key", async () => {
    await withBreakerFixture(async (fixture) => {
      vi.stubEnv("GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS", "0");
      try {
        resetGatewayHealthSummaryCacheForTests();
        const providerId = randomUUID();
        const connectionOneId = randomUUID();
        const connectionTwoId = randomUUID();
        const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
        await fixture.query(
          `
            insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled)
            values ($1, 'subscription', 'claude_code', null, 'Claude Code Breaker', 'https://api.anthropic.com', true)
          `,
          [providerId],
        );
        for (const [connectionId, accessToken, priority] of [
          [connectionOneId, "oauth-token-one", 1],
          [connectionTwoId, "oauth-token-two", 2],
        ] as const) {
          const encrypted = encryption.encrypt(
            JSON.stringify({
              accessToken,
              expiresAt: null,
              refreshToken: null,
              scopes: [],
              tokenType: "Bearer",
            }),
          );
          await fixture.query(
            `
              insert into provider_oauth (id, provider_id, priority, enabled, encrypted_token, token_expires_at, completed_at)
              values ($1, $2, $3, true, $4::jsonb, null, now())
            `,
            [connectionId, providerId, priority, JSON.stringify(encrypted)],
          );
        }
        const registry = createGatewayCircuitBreakerRegistry({ config: breakerTestConfig() });
        const attach = () =>
          attachGatewayProviderCredentialsLeniently({
            candidates: [breakerCredentialCandidate(providerId)],
            circuitBreakerRegistry: registry,
            databaseUrl: fixture.databaseUrl,
            encryptionKeySource: { kind: "inline", value: "test-master-key" },
          });

        const healthy = await attach();
        expect(healthy[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          connectionOneId,
          connectionTwoId,
        ]);
        expect(healthy[0]?.providerApiKeys?.map((key) => key.credentialKind)).toEqual([
          "oauth",
          "oauth",
        ]);

        await tripBreaker(registry, connectionOneId);
        const filtered = await attach();
        expect(filtered[0]?.providerApiKeys?.map((key) => key.providerConnectionId)).toEqual([
          connectionTwoId,
        ]);
      } finally {
        vi.unstubAllEnvs();
        resetGatewayHealthSummaryCacheForTests();
      }
    });
  });
});

async function withBreakerFixture(
  run: (fixture: TestPostgresFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_gateway_breaker_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function seedBreakerProviderWithTwoKeys(fixture: TestPostgresFixture): Promise<{
  keyOneId: string;
  keyTwoId: string;
  providerId: string;
}> {
  const providerId = randomUUID();
  const keyOneId = randomUUID();
  const keyTwoId = randomUUID();
  const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', null, 'Breaker Provider', 'http://provider.test/v1', true)
    `,
    [providerId],
  );
  for (const [id, prefix, priority] of [
    [keyOneId, "breaker-one", 1],
    [keyTwoId, "breaker-two", 2],
  ] as const) {
    const encrypted = encryption.encrypt(`provider-key-${prefix}`);
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, priority)
        values ($1, $2, $3, $4, $5, $6)
      `,
      [id, providerId, prefix, JSON.stringify(encrypted), encrypted.keyId, priority],
    );
  }
  return { keyOneId, keyTwoId, providerId };
}

function breakerCredentialCandidate(providerId: string): GatewayRouteCandidateSnapshot {
  return {
    candidateOrder: 1,
    displayName: "Breaker Model",
    modelId: "fake-model",
    price: {
      modelId: "fake-model",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId,
    providerKey: "openai",
    providerModelId: "pm-breaker-cred",
    weight: null,
  };
}
