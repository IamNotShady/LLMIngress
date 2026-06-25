import { PassThrough, Readable } from "node:stream";
import type { ModelTokenPrice } from "@llmingress/billing/price-registry";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBudgetReservation } from "../../apps/gateway/src/budgets.js";
import {
  createGatewayConfigRuntime,
  type GatewayConfigSnapshot,
  type RoutePolicyCandidateRow,
  rowToRoutePolicySnapshots,
} from "../../apps/gateway/src/config-reload.js";
import {
  executeFallbackChain,
  type FallbackChainCandidate,
} from "../../apps/gateway/src/fallback-chain.js";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { shippedSqlMigrations } from "../../packages/db/src/migration-status";
import type { HealthSummaryChangedPayload } from "../../packages/db/src/provider-health.js";
import {
  buildRouteAttemptCandidates,
  type RouteCandidate,
  type RoutePolicy,
  selectRouteAttempts,
  selectRouteCandidate,
} from "../../packages/domain/src/index";

// ---- module-level mocks for streaming fallback tests ----
// These are hoisted before any imports by vitest's vi.mock transform.
vi.mock("../../apps/gateway/src/rate-limits.js", () => ({
  enforceGatewayRateLimits: vi.fn(),
  releaseGatewayConcurrency: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../apps/gateway/src/budgets.js", () => ({
  reserveGatewayBudget: vi.fn(),
  releaseGatewayBudgetReservation: vi.fn().mockResolvedValue(undefined),
  finalizeGatewayBudgetReservation: vi.fn().mockResolvedValue(undefined),
  GatewayBudgetRejectedError: class GatewayBudgetRejectedError extends Error {
    body: unknown;
    statusCode: number;
    constructor(body: unknown, statusCode: number) {
      super("Budget rejected");
      this.body = body;
      this.statusCode = statusCode;
    }
  },
}));
vi.mock("../../apps/gateway/src/chat-completions.js", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/gateway/src/chat-completions.js")>();
  return {
    ...actual,
    attachGatewayProviderCredentials: vi.fn(),
    readGatewayMasterKeySource: vi.fn().mockReturnValue({ kind: "inline", value: "test-key" }),
    recordGatewayProviderApiKeyLastUsed: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../../apps/gateway/src/tracing.js", () => ({
  recordGatewayProviderTrace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../apps/gateway/src/fallback-chain.js", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/gateway/src/fallback-chain.js")>();
  return {
    ...actual,
    recordFailedAttemptInDatabase: vi.fn().mockResolvedValue(undefined),
    recordSucceededAttemptInDatabase: vi.fn().mockResolvedValue(undefined),
  };
});

describe("feat-117 strategy fallback chain", () => {
  describe("route attempt chain", () => {
    it("fixed strategy orders eligible candidates by candidateOrder asc", () => {
      const policy = makePolicy("fixed", [
        makeCandidate({ candidateOrder: 3, providerModelId: "model-c" }),
        makeCandidate({ candidateOrder: 1, providerModelId: "model-a" }),
        makeCandidate({ candidateOrder: 2, providerModelId: "model-b" }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      });

      expect(chain.map((c) => c.candidateOrder)).toEqual([1, 2, 3]);
    });

    it("cost_first strategy orders eligible priced candidates by cost asc, ties by candidateOrder", () => {
      const policy = makePolicy("cost_first", [
        makeCandidate({
          candidateOrder: 1,
          providerModelId: "expensive-model",
          price: pricedModel("m1", 2, 8),
        }),
        makeCandidate({
          candidateOrder: 2,
          providerModelId: "unknown-price-model",
          price: unknownPriceModel("m2"),
        }),
        makeCandidate({
          candidateOrder: 3,
          providerModelId: "cheap-model",
          price: pricedModel("m3", 0.1, 0.4),
        }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 1_000_000,
        estimatedOutputTokens: 1_000_000,
      });

      // unknown_price model excluded; cheap first, then expensive
      expect(chain.map((c) => c.providerModelId)).toEqual(["cheap-model", "expensive-model"]);
    });

    it("cost_first excludes unknown_price candidates", () => {
      const policy = makePolicy("cost_first", [
        makeCandidate({
          candidateOrder: 1,
          providerModelId: "priced",
          price: pricedModel("m1", 1, 4),
        }),
        makeCandidate({
          candidateOrder: 2,
          providerModelId: "unpriced",
          price: unknownPriceModel("m2"),
        }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      });

      expect(chain.every((c) => c.providerModelId !== "unpriced")).toBe(true);
      expect(chain).toHaveLength(1);
    });

    it("cost_first tie-breaks by candidateOrder asc", () => {
      const samePrice = pricedModel("same", 1, 4);
      const policy = makePolicy("cost_first", [
        makeCandidate({ candidateOrder: 2, providerModelId: "b", price: samePrice }),
        makeCandidate({ candidateOrder: 1, providerModelId: "a", price: samePrice }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      });

      expect(chain.map((c) => c.providerModelId)).toEqual(["a", "b"]);
    });

    it("quality_first strategy orders eligible priced candidates by cost desc", () => {
      const policy = makePolicy("quality_first", [
        makeCandidate({
          candidateOrder: 1,
          providerModelId: "cheap-model",
          price: pricedModel("m1", 0.1, 0.4),
        }),
        makeCandidate({
          candidateOrder: 2,
          providerModelId: "expensive-model",
          price: pricedModel("m2", 2, 8),
        }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 1_000_000,
        estimatedOutputTokens: 1_000_000,
      });

      expect(chain.map((c) => c.providerModelId)).toEqual(["expensive-model", "cheap-model"]);
    });

    it("random with random: () => 0 returns all eligible candidates with no duplicates", () => {
      const policy = makePolicy("random", [
        makeCandidate({ candidateOrder: 1, providerModelId: "a" }),
        makeCandidate({ candidateOrder: 2, providerModelId: "b" }),
        makeCandidate({ candidateOrder: 3, providerModelId: "c" }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
        random: () => 0,
      });

      expect(chain).toHaveLength(3);
      const ids = chain.map((c) => c.providerModelId);
      expect(new Set(ids).size).toBe(3);
      expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
    });

    it("health exclusion: unhealthy/auth_failed/quota_limited/network_error candidates are excluded", () => {
      const policy = makePolicy("fixed", [
        makeCandidate({
          candidateOrder: 1,
          providerModelId: "unhealthy",
          healthStatus: "unhealthy",
        }),
        makeCandidate({
          candidateOrder: 2,
          providerModelId: "auth-failed",
          healthStatus: "auth_failed",
        }),
        makeCandidate({
          candidateOrder: 3,
          providerModelId: "quota",
          healthStatus: "quota_limited",
        }),
        makeCandidate({
          candidateOrder: 4,
          providerModelId: "network-err",
          healthStatus: "network_error",
        }),
        makeCandidate({ candidateOrder: 5, providerModelId: "healthy", healthStatus: "healthy" }),
        makeCandidate({
          candidateOrder: 6,
          providerModelId: "unknown-status",
          healthStatus: "unknown",
        }),
        makeCandidate({ candidateOrder: 7, providerModelId: "no-status" }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      });

      const ids = chain.map((c) => c.providerModelId);
      expect(ids).not.toContain("unhealthy");
      expect(ids).not.toContain("auth-failed");
      expect(ids).not.toContain("quota");
      expect(ids).not.toContain("network-err");
      expect(ids).toContain("healthy");
      expect(ids).toContain("unknown-status");
      expect(ids).toContain("no-status");
    });

    it("all-ineligible: buildRouteAttemptCandidates returns [] and selectRouteCandidate throws", () => {
      const policy = makePolicy("fixed", [
        makeCandidate({ candidateOrder: 1, providerModelId: "down-1", healthStatus: "unhealthy" }),
        makeCandidate({
          candidateOrder: 2,
          providerModelId: "down-2",
          healthStatus: "auth_failed",
        }),
      ]);

      const chain = buildRouteAttemptCandidates({
        routePolicy: policy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      });
      expect(chain).toEqual([]);

      const snapshot = {
        routePolicies: [policy],
      };
      expect(() =>
        selectRouteCandidate({
          estimatedInputTokens: 100,
          estimatedOutputTokens: 100,
          snapshot,
          virtualModelId: "vm-1",
        }),
      ).toThrow();
    });
  });

  describe("migration 0048", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0048" && candidate.name === "remove_route_policy_candidate_fallback",
    );

    it("ships the 0048 remove_route_policy_candidate_fallback migration", () => {
      expect(
        migration,
        "missing 0048_remove_route_policy_candidate_fallback migration",
      ).toBeDefined();
    });

    it("0048 SQL drops the is_fallback column", () => {
      expect(migration).toBeDefined();
      const sql = (migration?.sql ?? "").toLowerCase();
      expect(sql).toContain("drop column");
      expect(sql).toContain("is_fallback");
    });

    it("0048 SQL re-sequences candidate_order using row_number() over route_policy_id", () => {
      expect(migration).toBeDefined();
      const sql = (migration?.sql ?? "").toLowerCase();
      expect(sql).toContain("row_number()");
      expect(sql).toContain("route_policy_id");
    });

    it("shippedSqlMigrations contains a 0048 entry whose checksum matches the loaded SQL", () => {
      expect(migration).toBeDefined();
      expect(shippedSqlMigrations.find((entry) => entry.id === "0048")).toEqual({
        checksum: migration?.checksum,
        id: "0048",
        name: "remove_route_policy_candidate_fallback",
      });
    });
  });
});

describe("gateway snapshot health", () => {
  // The SQL-level health JOIN (provider_health_summary left join) is covered by the feat-075 / feat-117 e2e.
  // This block tests the pure row→snapshot mapper in isolation.

  it("rowToRoutePolicySnapshots maps healthStatus: 'unhealthy' and omits isFallback", () => {
    const row = makeCandidateRow({ healthStatus: "unhealthy" });
    const snapshots = rowToRoutePolicySnapshots([row]);
    expect(snapshots).toHaveLength(1);
    const candidate = snapshots[0]?.candidates[0];
    expect(candidate?.healthStatus).toBe("unhealthy");
    expect(Object.hasOwn(candidate, "isFallback")).toBe(false);
  });

  it("rowToRoutePolicySnapshots passes through healthStatus: 'healthy'", () => {
    const row = makeCandidateRow({ healthStatus: "healthy" });
    const snapshots = rowToRoutePolicySnapshots([row]);
    const candidate = snapshots[0]?.candidates[0];
    expect(candidate?.healthStatus).toBe("healthy");
    expect(Object.hasOwn(candidate, "isFallback")).toBe(false);
  });
});

describe("health force reload", () => {
  it("force-refreshes snapshot when health changes even though config version stays the same", async () => {
    const FIXED_VERSION = 5;

    // First call returns "healthy", subsequent calls return "unhealthy"
    let callCount = 0;
    const loadLatestSnapshot = vi.fn(async (): Promise<GatewayConfigSnapshot> => {
      callCount++;
      const healthStatus = callCount === 1 ? "healthy" : "unhealthy";
      return {
        loadedAt: new Date("2026-01-01T00:00:00.000Z"),
        version: FIXED_VERSION,
        providers: [],
        routePolicies: [
          {
            id: "policy-1",
            strategy: "fixed",
            virtualModelId: "vm-1",
            virtualModelName: "test-model",
            candidates: [
              {
                candidateOrder: 1,
                displayName: "test",
                healthStatus,
                modelId: "gpt-4",
                price: {
                  modelId: "gpt-4",
                  priceVersion: "v1",
                  providerKey: "openai",
                  reason: "model_not_in_builtin_registry",
                  status: "unknown_price",
                },
                providerId: "provider-1",
                providerKey: "openai",
                providerModelId: "model-1",
              },
            ],
          },
        ],
      };
    });

    let capturedHealthNotify: ((payload: HealthSummaryChangedPayload) => void) | undefined;
    const healthListenerClose = vi.fn(async () => {});

    const runtime = createGatewayConfigRuntime({
      enableNotifications: true,
      loadLatestSnapshot,
      createConfigChangedListener: async (_onNotification) => {
        return { close: async () => {} };
      },
      createHealthSummaryChangedListener: async (onNotification) => {
        capturedHealthNotify = onNotification;
        return { close: healthListenerClose };
      },
      reconcileIntervalMs: 0,
    });

    await runtime.start();

    // Initial snapshot should show "healthy"
    expect(runtime.getSnapshot().routePolicies[0]?.candidates[0]?.healthStatus).toBe("healthy");
    expect(runtime.getSnapshot().version).toBe(FIXED_VERSION);

    // Simulate a health_summary_changed notification
    const samplePayload: HealthSummaryChangedPayload = {
      consecutiveFailures: 1,
      eventId: "event-1",
      providerId: "provider-1",
      providerModelId: "model-1",
      status: "unhealthy",
      summaryId: "summary-1",
    };
    capturedHealthNotify?.(samplePayload);

    // Wait for async force reload to complete
    await expect
      .poll(() => runtime.getSnapshot().routePolicies[0]?.candidates[0]?.healthStatus)
      .toBe("unhealthy");

    // Version is still FIXED_VERSION — health change didn't bump the version
    expect(runtime.getSnapshot().version).toBe(FIXED_VERSION);

    await runtime.stop();
    expect(healthListenerClose).toHaveBeenCalledTimes(1);
  });

  it("reconcile() recovers a health change even when the config version is unchanged (P2b)", async () => {
    const FIXED_VERSION = 7;
    let callCount = 0;
    const loadLatestSnapshot = vi.fn(async (): Promise<GatewayConfigSnapshot> => {
      callCount++;
      const healthStatus = callCount === 1 ? "healthy" : "unhealthy";
      return {
        loadedAt: new Date("2026-01-01T00:00:00.000Z"),
        version: FIXED_VERSION,
        providers: [],
        routePolicies: [
          {
            id: "policy-1",
            strategy: "fixed",
            virtualModelId: "vm-1",
            virtualModelName: "test-model",
            candidates: [
              {
                candidateOrder: 1,
                displayName: "test",
                healthStatus,
                modelId: "gpt-4",
                price: {
                  modelId: "gpt-4",
                  priceVersion: "v1",
                  providerKey: "openai",
                  reason: "model_not_in_builtin_registry",
                  status: "unknown_price",
                },
                providerId: "provider-1",
                providerKey: "openai",
                providerModelId: "model-1",
              },
            ],
          },
        ],
      };
    });

    const runtime = createGatewayConfigRuntime({
      enableNotifications: false,
      loadLatestSnapshot,
      reconcileIntervalMs: 0,
    });

    await runtime.start();
    expect(runtime.getSnapshot().routePolicies[0]?.candidates[0]?.healthStatus).toBe("healthy");

    // A dropped health_summary_changed notification is recovered by the periodic
    // reconcile, which now force-reloads instead of gating on a newer config version.
    await runtime.reconcile();
    expect(runtime.getSnapshot().routePolicies[0]?.candidates[0]?.healthStatus).toBe("unhealthy");
    expect(runtime.getSnapshot().version).toBe(FIXED_VERSION);

    await runtime.stop();
  });
});

// ---- fallback chain execution ----

describe("fallback chain", () => {
  it("429 on candidate A then success on candidate B returns B's success with retryable failed attempt", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "rate_limited",
          errorMessage: "429 too many requests",
          ok: false,
          retryable: true,
          statusCode: 429,
        })
        .mockResolvedValueOnce({
          body: { id: "success-b", choices: [] },
          ok: true,
          providerRequestId: "req-b",
          statusCode: 200,
        }),
    };

    const result = await executeFallbackChain({
      adapter,
      candidates: [candidateA, candidateB],
      databaseUrl: undefined,
      request: { messages: [{ content: "hello", role: "user" }], stream: false },
    });

    expect(result.selectedCandidate.providerModelId).toBe("model-b");
    expect(result.result.ok).toBe(true);
    expect(result.failedAttempts).toHaveLength(1);
    expect(result.failedAttempts[0]).toMatchObject({
      retryable: true,
      statusCode: 429,
    });
  });

  it("400 on candidate A stops the chain without trying candidate B", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });

    const adapter = {
      chatCompletion: vi.fn().mockResolvedValueOnce({
        body: null,
        errorCode: "bad_request",
        errorMessage: "400 bad request",
        ok: false,
        retryable: false,
        statusCode: 400,
      }),
    };

    await expect(
      executeFallbackChain({
        adapter,
        candidates: [candidateA, candidateB],
        databaseUrl: undefined,
        request: { messages: [{ content: "hello", role: "user" }], stream: false },
      }),
    ).rejects.toThrow("400 bad request");

    expect(adapter.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("5xx failure is retryable and advances to the next candidate", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "internal_server_error",
          errorMessage: "503 service unavailable",
          ok: false,
          retryable: true,
          statusCode: 503,
        })
        .mockResolvedValueOnce({
          body: { id: "ok-b", choices: [] },
          ok: true,
          providerRequestId: "req-b",
          statusCode: 200,
        }),
    };

    const result = await executeFallbackChain({
      adapter,
      candidates: [candidateA, candidateB],
      databaseUrl: undefined,
      request: { messages: [{ content: "hello", role: "user" }], stream: false },
    });

    expect(result.selectedCandidate.providerModelId).toBe("model-b");
    expect(result.failedAttempts[0]).toMatchObject({ retryable: true, statusCode: 503 });
  });

  it("network-null failure is retryable and advances to the next candidate", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "network_error",
          errorMessage: "socket closed",
          ok: false,
          retryable: true,
          statusCode: null,
        })
        .mockResolvedValueOnce({
          body: { id: "ok-b", choices: [] },
          ok: true,
          providerRequestId: "req-b",
          statusCode: 200,
        }),
    };

    const result = await executeFallbackChain({
      adapter,
      candidates: [candidateA, candidateB],
      databaseUrl: undefined,
      request: { messages: [{ content: "hello", role: "user" }], stream: false },
    });

    expect(result.selectedCandidate.providerModelId).toBe("model-b");
    expect(result.failedAttempts[0]).toMatchObject({
      retryable: true,
      statusCode: null,
      failedBeforeFirstByte: true,
    });
  });

  it("budget hooks: reserveAttempt before each call, releaseAttempt on failure, finalizeAttempt on success", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });

    const reservationA: GatewayBudgetReservation = {
      budgetPeriodId: "period-a",
      id: "res-a",
      reservedCostUsd: 0.01,
      reservedInputTokens: 10,
      reservedOutputTokens: 10,
      reservedTotalTokens: 20,
    };
    const reservationB: GatewayBudgetReservation = {
      budgetPeriodId: "period-b",
      id: "res-b",
      reservedCostUsd: 0.01,
      reservedInputTokens: 10,
      reservedOutputTokens: 10,
      reservedTotalTokens: 20,
    };

    const reserveAttempt = vi
      .fn()
      .mockResolvedValueOnce(reservationA)
      .mockResolvedValueOnce(reservationB);
    const releaseAttempt = vi.fn().mockResolvedValue(undefined);
    const finalizeAttempt = vi.fn().mockResolvedValue(undefined);

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "rate_limited",
          errorMessage: "429",
          ok: false,
          retryable: true,
          statusCode: 429,
        })
        .mockResolvedValueOnce({
          body: { id: "ok-b", choices: [] },
          ok: true,
          providerRequestId: "req-b",
          statusCode: 200,
        }),
    };

    await executeFallbackChain({
      adapter,
      candidates: [candidateA, candidateB],
      databaseUrl: undefined,
      finalizeAttempt,
      releaseAttempt,
      reserveAttempt,
      request: { messages: [{ content: "hello", role: "user" }], stream: false },
    });

    // reserveAttempt called before each provider call
    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(reserveAttempt).toHaveBeenNthCalledWith(1, candidateA);
    expect(reserveAttempt).toHaveBeenNthCalledWith(2, candidateB);

    // releaseAttempt only for the failed attempt (A), not the successful one (B)
    expect(releaseAttempt).toHaveBeenCalledTimes(1);
    expect(releaseAttempt).toHaveBeenCalledWith(reservationA);

    // finalizeAttempt exactly once, for the winner
    expect(finalizeAttempt).toHaveBeenCalledTimes(1);
    expect(finalizeAttempt).toHaveBeenCalledWith(reservationB);
  });

  it("health split: recordHealthEvent NOT called when all failures are retryable (429)", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });
    const recordHealthEvent = vi.fn().mockResolvedValue(undefined);

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "rate_limited",
          errorMessage: "429",
          ok: false,
          retryable: true,
          statusCode: 429,
        })
        .mockResolvedValueOnce({
          body: { id: "ok-b", choices: [] },
          ok: true,
          providerRequestId: "req-b",
          statusCode: 200,
        }),
    };

    await executeFallbackChain({
      adapter,
      candidates: [candidateA, candidateB],
      databaseUrl: "postgresql://localhost/test",
      recordHealthEvent,
      request: { messages: [{ content: "hello", role: "user" }], stream: false },
    });

    expect(recordHealthEvent).not.toHaveBeenCalled();
  });

  it("health split: recordHealthEvent IS called when a non-retryable failure (401) occurs", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const recordHealthEvent = vi.fn().mockResolvedValue(undefined);

    const adapter = {
      chatCompletion: vi.fn().mockResolvedValueOnce({
        body: null,
        errorCode: "auth_failed",
        errorMessage: "401 unauthorized",
        ok: false,
        retryable: false,
        statusCode: 401,
      }),
    };

    await expect(
      executeFallbackChain({
        adapter,
        candidates: [candidateA],
        databaseUrl: "postgresql://localhost/test",
        recordHealthEvent,
        request: { messages: [{ content: "hello", role: "user" }], stream: false },
      }),
    ).rejects.toThrow("401 unauthorized");

    // called twice: once for provider-level, once for providerModel-level
    expect(recordHealthEvent).toHaveBeenCalledTimes(2);
  });

  it("health split: recordHealthEvent NOT called for 5xx that exhausts all candidates", async () => {
    const candidateA = fallbackCandidate({ providerModelId: "model-a" });
    const candidateB = fallbackCandidate({ providerModelId: "model-b" });
    const recordHealthEvent = vi.fn().mockResolvedValue(undefined);

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "server_error",
          errorMessage: "503",
          ok: false,
          retryable: true,
          statusCode: 503,
        })
        .mockResolvedValueOnce({
          body: null,
          errorCode: "server_error",
          errorMessage: "503",
          ok: false,
          retryable: true,
          statusCode: 503,
        }),
    };

    await expect(
      executeFallbackChain({
        adapter,
        candidates: [candidateA, candidateB],
        databaseUrl: "postgresql://localhost/test",
        recordHealthEvent,
        request: { messages: [{ content: "hello", role: "user" }], stream: false },
      }),
    ).rejects.toThrow();

    // health NOT recorded because all failures are retryable — only the exhaustion error is thrown
    expect(recordHealthEvent).not.toHaveBeenCalled();
  });

  it("multi-key: key1 fails (retryable), key2 succeeds → returns success via key2", async () => {
    const candidate = fallbackCandidate({
      providerModelId: "model-a",
      providerApiKeys: [
        { apiKey: "key-1", providerApiKeyId: "kid-1" },
        { apiKey: "key-2", providerApiKeyId: "kid-2" },
      ],
    });

    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "rate_limited",
          errorMessage: "429",
          ok: false,
          retryable: true,
          statusCode: 429,
        })
        .mockResolvedValueOnce({
          body: { id: "ok-key2", choices: [] },
          ok: true,
          providerRequestId: "req-key2",
          statusCode: 200,
        }),
    };

    const result = await executeFallbackChain({
      adapter,
      candidates: [candidate],
      databaseUrl: undefined,
      request: { messages: [{ content: "hello", role: "user" }], stream: false },
    });

    expect(result.selectedCandidate.providerModelId).toBe("model-a");
    expect(result.selectedCandidate.providerApiKeyId).toBe("kid-2");
    expect(result.failedAttempts).toHaveLength(1);
    expect(result.failedAttempts[0]).toMatchObject({ retryable: true, statusCode: 429 });
    expect(adapter.chatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe("selectRouteAttempts", () => {
  it("random strategy with injected random: decision.selectedCandidateOrder === chain[0].candidateOrder (single-shuffle consistency)", () => {
    // With random: () => 0, Fisher-Yates always picks index 0 in each iteration
    // so the shuffle result is deterministic. The key property is that the
    // decision's selectedCandidateOrder matches the actual head of the chain.
    const policy = makePolicy("random", [
      makeCandidate({ candidateOrder: 1, providerModelId: "model-a" }),
      makeCandidate({ candidateOrder: 2, providerModelId: "model-b" }),
      makeCandidate({ candidateOrder: 3, providerModelId: "model-c" }),
    ]);
    const snapshot = { routePolicies: [policy] };

    const result = selectRouteAttempts({
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      snapshot,
      virtualModelId: "vm-1",
      random: () => 0,
    });

    expect(result.decision).toBeDefined();
    expect(result.chain.length).toBeGreaterThan(0);
    // Single-shuffle consistency: decision head must match chain head
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(result.decision!.routeReason.selectedCandidateOrder).toBe(
      result.chain[0]!.candidateOrder,
    );
    // All eligible candidates are in the chain
    expect(result.chain).toHaveLength(3);
  });

  it("empty policy: decision === undefined and chain.length === 0", () => {
    const policy = makePolicy("fixed", []);
    const snapshot = { routePolicies: [policy] };

    const result = selectRouteAttempts({
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      snapshot,
      virtualModelId: "vm-1",
    });

    expect(result.decision).toBeUndefined();
    expect(result.chain).toHaveLength(0);
  });

  it("all-ineligible policy (all unhealthy): decision === undefined, chain.length === 0", () => {
    const policy = makePolicy("fixed", [
      makeCandidate({ candidateOrder: 1, providerModelId: "model-a", healthStatus: "unhealthy" }),
      makeCandidate({ candidateOrder: 2, providerModelId: "model-b", healthStatus: "auth_failed" }),
    ]);
    const snapshot = { routePolicies: [policy] };

    const result = selectRouteAttempts({
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      snapshot,
      virtualModelId: "vm-1",
    });

    expect(result.decision).toBeUndefined();
    expect(result.chain).toHaveLength(0);
  });

  it("selectRouteCandidate still throws when chain is empty", () => {
    const policy = makePolicy("fixed", [
      makeCandidate({ candidateOrder: 1, providerModelId: "model-a", healthStatus: "unhealthy" }),
    ]);
    const snapshot = { routePolicies: [policy] };

    expect(() =>
      selectRouteCandidate({
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
        snapshot,
        virtualModelId: "vm-1",
      }),
    ).toThrow("has no eligible candidates");
  });

  it("fixed strategy: chain[0] is the lowest-order eligible and decision matches it", () => {
    const policy = makePolicy("fixed", [
      makeCandidate({ candidateOrder: 3, providerModelId: "model-c" }),
      makeCandidate({ candidateOrder: 1, providerModelId: "model-a" }),
      makeCandidate({ candidateOrder: 2, providerModelId: "model-b" }),
    ]);
    const snapshot = { routePolicies: [policy] };

    const result = selectRouteAttempts({
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
      snapshot,
      virtualModelId: "vm-1",
    });

    expect(result.decision).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(result.chain[0]!.candidateOrder).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(result.decision!.routeReason.selectedCandidateOrder).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(result.decision!.providerModelId).toBe("model-a");
  });
});

// ---- helpers ----

function fallbackCandidate(input: {
  providerModelId: string;
  providerApiKeys?: FallbackChainCandidate["providerApiKeys"];
}): FallbackChainCandidate {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    candidateOrder: 1,
    displayName: input.providerModelId,
    healthStatus: "healthy",
    modelId: input.providerModelId,
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: 1,
      modelId: input.providerModelId,
      outputUsdPerMillionTokens: 4,
      priceVersion: "mvp-static-2026-06-13",
      providerKey: "openai",
      snapshotDate: "2026-06-13",
      source: "built_in_static_snapshot",
      status: "priced",
      unit: "per_1m_tokens",
    },
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: input.providerModelId,
    ...(input.providerApiKeys ? { providerApiKeys: input.providerApiKeys } : {}),
  };
}

// ---- helpers ----

function makeCandidateRow(
  overrides: Partial<RoutePolicyCandidateRow> = {},
): RoutePolicyCandidateRow {
  return {
    candidateOrder: 1,
    capabilityMetadata: null,
    cachedInputUsdPerMillionTokens: null,
    contextWindow: null,
    displayName: "test-model",
    healthStatus: "unknown",
    id: "policy-1",
    inputUsdPerMillionTokens: "1",
    modelId: "gpt-4",
    outputUsdPerMillionTokens: "4",
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: "model-1",
    rules: null,
    strategy: "fixed",
    supportsTools: false,
    syncedAt: null,
    syncedCachedInputUsdPerMillionTokens: null,
    syncedInputUsdPerMillionTokens: null,
    syncedOutputUsdPerMillionTokens: null,
    syncedPriceVersion: null,
    syncedSourceUrl: null,
    updatedAt: null,
    virtualModelId: "vm-1",
    virtualModelName: "test-virtual-model",
    ...overrides,
  };
}

function makePolicy(strategy: RoutePolicy["strategy"], candidates: RouteCandidate[]): RoutePolicy {
  return {
    candidates,
    id: "test-policy",
    strategy,
    virtualModelId: "vm-1",
    virtualModelName: "test-model",
  };
}

function makeCandidate(input: {
  candidateOrder: number;
  providerModelId: string;
  price?: ModelTokenPrice;
  healthStatus?: RouteCandidate["healthStatus"];
}): RouteCandidate {
  return {
    candidateOrder: input.candidateOrder,
    displayName: input.providerModelId,
    healthStatus: input.healthStatus,
    modelId: input.providerModelId,
    price: input.price ?? pricedModel(input.providerModelId, 1, 4),
    providerId: "provider",
    providerKey: "openai",
    providerModelId: input.providerModelId,
  };
}

function pricedModel(modelId: string, inputPrice: number, outputPrice: number): ModelTokenPrice {
  return {
    currency: "USD",
    inputUsdPerMillionTokens: inputPrice,
    modelId,
    outputUsdPerMillionTokens: outputPrice,
    priceVersion: "mvp-static-2026-06-13",
    providerKey: "openai",
    snapshotDate: "2026-06-13",
    source: "built_in_static_snapshot",
    sourceUrl: "https://example.test/pricing",
    status: "priced",
    unit: "per_1m_tokens",
  };
}

function unknownPriceModel(modelId: string): ModelTokenPrice {
  return {
    modelId,
    priceVersion: "mvp-static-2026-06-13",
    providerKey: "openai",
    reason: "model_not_in_builtin_registry",
    status: "unknown_price",
  };
}

// ---- streaming fallback helpers ----

function makeStreamingSnapshot(
  candidates: Array<{ providerModelId: string; candidateOrder: number }>,
): GatewayConfigSnapshot {
  return {
    loadedAt: new Date(),
    providers: [],
    routePolicies: [
      {
        id: "policy-1",
        strategy: "fixed",
        virtualModelId: "vm-1",
        virtualModelName: "test-model",
        candidates: candidates.map((c) => ({
          candidateOrder: c.candidateOrder,
          displayName: c.providerModelId,
          healthStatus: "healthy" as const,
          modelId: c.providerModelId,
          price: pricedModel(c.providerModelId, 1, 4),
          providerId: `provider-${c.candidateOrder}`,
          providerKey: "openai",
          providerModelId: c.providerModelId,
        })),
      },
    ],
    version: 1,
  };
}

function makeStreamingCandidate(
  providerModelId: string,
  candidateOrder: number,
): FallbackChainCandidate {
  return {
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    candidateOrder,
    displayName: providerModelId,
    healthStatus: "healthy",
    modelId: providerModelId,
    price: pricedModel(providerModelId, 1, 4),
    providerId: `provider-${candidateOrder}`,
    providerKey: "openai",
    providerModelId,
  };
}

function makeOkStreamResponse(): Response {
  const pt = new PassThrough();
  pt.end("data: [DONE]\n\n");
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return new Response(Readable.toWeb(pt) as any, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeStreamErrorBeforeFirstChunkResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("stream broke before first byte"));
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return new Response(body as any, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeEmptyStreamResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return new Response(body as any, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function drainStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ---- streaming fallback describe ----

describe("streaming fallback", () => {
  // Import at the describe level so vi.mock stubs are in place.
  // We use lazy requires inside each test via a dynamic import to avoid
  // module resolution ordering issues.

  it("A returns 429, B returns 200 stream → result ok:true, streamed bytes from B; fetch called A then B", async () => {
    const { enforceGatewayRateLimits } = await import("../../apps/gateway/src/rate-limits.js");
    const { reserveGatewayBudget } = await import("../../apps/gateway/src/budgets.js");
    const { attachGatewayProviderCredentials } = await import(
      "../../apps/gateway/src/chat-completions.js"
    );
    const { executeGatewayStreamingRequest } = await import("../../apps/gateway/src/streaming.js");

    vi.mocked(enforceGatewayRateLimits).mockResolvedValue({
      concurrencyLease: {
        agentApiKeyId: "key-1",
        window: { windowEnd: new Date(), windowStart: new Date() },
      },
      ok: true,
    });
    vi.mocked(reserveGatewayBudget).mockResolvedValue({
      ok: true,
      reservation: {
        budgetPeriodId: "bp",
        id: "res-1",
        reservedCostUsd: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reservedTotalTokens: 0,
      },
    });
    vi.mocked(attachGatewayProviderCredentials)
      .mockResolvedValueOnce([makeStreamingCandidate("model-a", 1)])
      .mockResolvedValueOnce([makeStreamingCandidate("model-b", 2)]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(makeOkStreamResponse());

    const snapshot = makeStreamingSnapshot([
      { providerModelId: "model-a", candidateOrder: 1 },
      { providerModelId: "model-b", candidateOrder: 2 },
    ]);

    const result = await executeGatewayStreamingRequest({
      agentApiKeyId: "key-1",
      databaseUrl: "",
      fetch: fetchMock,
      protocol: "chat_completions",
      requestBody: { messages: [{ role: "user", content: "hi" }], stream: true },
      requestId: "req-1",
      snapshot,
      virtualModel: { id: "vm-1", name: "test-model" },
    });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    // fetch was called for both A (429) and B (200)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call was to A's URL (contains model-a in body or headers)
    // Second call was to B's URL
    expect(fetchMock.mock.calls[0]?.[0]).toContain("openai.com");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("openai.com");

    if (result.ok) {
      const bytes = await drainStream(result.body);
      expect(bytes.toString()).toContain("[DONE]");
    }

    vi.clearAllMocks();
  });

  it("A returns 400 → result ok:false with 502 statusCode; B not fetched", async () => {
    const { enforceGatewayRateLimits } = await import("../../apps/gateway/src/rate-limits.js");
    const { reserveGatewayBudget } = await import("../../apps/gateway/src/budgets.js");
    const { attachGatewayProviderCredentials } = await import(
      "../../apps/gateway/src/chat-completions.js"
    );
    const { executeGatewayStreamingRequest } = await import("../../apps/gateway/src/streaming.js");

    vi.mocked(enforceGatewayRateLimits).mockResolvedValue({
      concurrencyLease: {
        agentApiKeyId: "key-1",
        window: { windowEnd: new Date(), windowStart: new Date() },
      },
      ok: true,
    });
    vi.mocked(reserveGatewayBudget).mockResolvedValue({
      ok: true,
      reservation: {
        budgetPeriodId: "bp",
        id: "res-1",
        reservedCostUsd: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reservedTotalTokens: 0,
      },
    });
    vi.mocked(attachGatewayProviderCredentials).mockResolvedValue([
      makeStreamingCandidate("model-a", 1),
    ]);

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));

    const snapshot = makeStreamingSnapshot([
      { providerModelId: "model-a", candidateOrder: 1 },
      { providerModelId: "model-b", candidateOrder: 2 },
    ]);

    const result = await executeGatewayStreamingRequest({
      agentApiKeyId: "key-1",
      databaseUrl: "",
      fetch: fetchMock,
      protocol: "chat_completions",
      requestBody: { messages: [{ role: "user", content: "hi" }], stream: true },
      requestId: "req-1",
      snapshot,
      virtualModel: { id: "vm-1", name: "test-model" },
    });

    expect(result.ok).toBe(false);
    // FIX m1: assert result.statusCode (400 → provider_request_failed → 502)
    expect(result.statusCode).toBe(502);
    // B was never fetched because 400 is non-retryable
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
  });

  it("single candidate 200 stream → streams normally", async () => {
    const { enforceGatewayRateLimits } = await import("../../apps/gateway/src/rate-limits.js");
    const { reserveGatewayBudget } = await import("../../apps/gateway/src/budgets.js");
    const { attachGatewayProviderCredentials } = await import(
      "../../apps/gateway/src/chat-completions.js"
    );
    const { executeGatewayStreamingRequest } = await import("../../apps/gateway/src/streaming.js");

    vi.mocked(enforceGatewayRateLimits).mockResolvedValue({
      concurrencyLease: {
        agentApiKeyId: "key-1",
        window: { windowEnd: new Date(), windowStart: new Date() },
      },
      ok: true,
    });
    vi.mocked(reserveGatewayBudget).mockResolvedValue({
      ok: true,
      reservation: {
        budgetPeriodId: "bp",
        id: "res-1",
        reservedCostUsd: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reservedTotalTokens: 0,
      },
    });
    vi.mocked(attachGatewayProviderCredentials).mockResolvedValue([
      makeStreamingCandidate("model-a", 1),
    ]);

    const fetchMock = vi.fn().mockResolvedValueOnce(makeOkStreamResponse());

    const snapshot = makeStreamingSnapshot([{ providerModelId: "model-a", candidateOrder: 1 }]);

    const result = await executeGatewayStreamingRequest({
      agentApiKeyId: "key-1",
      databaseUrl: "",
      fetch: fetchMock,
      protocol: "chat_completions",
      requestBody: { messages: [{ role: "user", content: "hi" }], stream: true },
      requestId: "req-1",
      snapshot,
      virtualModel: { id: "vm-1", name: "test-model" },
    });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (result.ok) {
      const bytes = await drainStream(result.body);
      expect(bytes.toString()).toContain("[DONE]");
    }

    vi.clearAllMocks();
  });

  it("A returns 200 whose stream errors before the first chunk → falls back to B (P1)", async () => {
    const { enforceGatewayRateLimits } = await import("../../apps/gateway/src/rate-limits.js");
    const { reserveGatewayBudget } = await import("../../apps/gateway/src/budgets.js");
    const { attachGatewayProviderCredentials } = await import(
      "../../apps/gateway/src/chat-completions.js"
    );
    const { executeGatewayStreamingRequest } = await import("../../apps/gateway/src/streaming.js");

    vi.mocked(enforceGatewayRateLimits).mockResolvedValue({
      concurrencyLease: {
        agentApiKeyId: "key-1",
        window: { windowEnd: new Date(), windowStart: new Date() },
      },
      ok: true,
    });
    vi.mocked(reserveGatewayBudget).mockResolvedValue({
      ok: true,
      reservation: {
        budgetPeriodId: "bp",
        id: "res-1",
        reservedCostUsd: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reservedTotalTokens: 0,
      },
    });
    vi.mocked(attachGatewayProviderCredentials)
      .mockResolvedValueOnce([makeStreamingCandidate("model-a", 1)])
      .mockResolvedValueOnce([makeStreamingCandidate("model-b", 2)]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeStreamErrorBeforeFirstChunkResponse())
      .mockResolvedValueOnce(makeOkStreamResponse());

    const snapshot = makeStreamingSnapshot([
      { providerModelId: "model-a", candidateOrder: 1 },
      { providerModelId: "model-b", candidateOrder: 2 },
    ]);

    const result = await executeGatewayStreamingRequest({
      agentApiKeyId: "key-1",
      databaseUrl: "",
      fetch: fetchMock,
      protocol: "chat_completions",
      requestBody: { messages: [{ role: "user", content: "hi" }], stream: true },
      requestId: "req-1",
      snapshot,
      virtualModel: { id: "vm-1", name: "test-model" },
    });

    // Pre-first-chunk stream error on A must fall back to B (not commit A's 200).
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (result.ok) {
      const bytes = await drainStream(result.body);
      expect(bytes.toString()).toContain("[DONE]");
    }

    vi.clearAllMocks();
  });

  it("A returns 200 with an empty stream (no chunks) → falls back to B (P1)", async () => {
    const { enforceGatewayRateLimits } = await import("../../apps/gateway/src/rate-limits.js");
    const { reserveGatewayBudget } = await import("../../apps/gateway/src/budgets.js");
    const { attachGatewayProviderCredentials } = await import(
      "../../apps/gateway/src/chat-completions.js"
    );
    const { executeGatewayStreamingRequest } = await import("../../apps/gateway/src/streaming.js");

    vi.mocked(enforceGatewayRateLimits).mockResolvedValue({
      concurrencyLease: {
        agentApiKeyId: "key-1",
        window: { windowEnd: new Date(), windowStart: new Date() },
      },
      ok: true,
    });
    vi.mocked(reserveGatewayBudget).mockResolvedValue({
      ok: true,
      reservation: {
        budgetPeriodId: "bp",
        id: "res-1",
        reservedCostUsd: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reservedTotalTokens: 0,
      },
    });
    vi.mocked(attachGatewayProviderCredentials)
      .mockResolvedValueOnce([makeStreamingCandidate("model-a", 1)])
      .mockResolvedValueOnce([makeStreamingCandidate("model-b", 2)]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeEmptyStreamResponse())
      .mockResolvedValueOnce(makeOkStreamResponse());

    const snapshot = makeStreamingSnapshot([
      { providerModelId: "model-a", candidateOrder: 1 },
      { providerModelId: "model-b", candidateOrder: 2 },
    ]);

    const result = await executeGatewayStreamingRequest({
      agentApiKeyId: "key-1",
      databaseUrl: "",
      fetch: fetchMock,
      protocol: "chat_completions",
      requestBody: { messages: [{ role: "user", content: "hi" }], stream: true },
      requestId: "req-1",
      snapshot,
      virtualModel: { id: "vm-1", name: "test-model" },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
  });
});
