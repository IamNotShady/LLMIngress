import { describe, expect, it, vi } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { shippedSqlMigrations } from "../../packages/db/src/migration-status";
import {
  buildRouteAttemptCandidates,
  selectRouteCandidate,
  type RouteCandidate,
  type RoutePolicy,
} from "../../packages/domain/src/index";
import type { ModelTokenPrice } from "@llmingress/billing/price-registry";
import {
  createGatewayConfigRuntime,
  rowToRoutePolicySnapshots,
  type GatewayConfigSnapshot,
  type RoutePolicyCandidateRow,
} from "../../apps/gateway/src/config-reload.js";
import type { HealthSummaryChangedPayload } from "../../packages/db/src/provider-health.js";

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
        makeCandidate({ candidateOrder: 1, providerModelId: "unhealthy", healthStatus: "unhealthy" }),
        makeCandidate({ candidateOrder: 2, providerModelId: "auth-failed", healthStatus: "auth_failed" }),
        makeCandidate({ candidateOrder: 3, providerModelId: "quota", healthStatus: "quota_limited" }),
        makeCandidate({ candidateOrder: 4, providerModelId: "network-err", healthStatus: "network_error" }),
        makeCandidate({ candidateOrder: 5, providerModelId: "healthy", healthStatus: "healthy" }),
        makeCandidate({ candidateOrder: 6, providerModelId: "unknown-status", healthStatus: "unknown" }),
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
        makeCandidate({ candidateOrder: 2, providerModelId: "down-2", healthStatus: "auth_failed" }),
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
        candidate.id === "0048" &&
        candidate.name === "remove_route_policy_candidate_fallback",
    );

    it("ships the 0048 remove_route_policy_candidate_fallback migration", () => {
      expect(migration, "missing 0048_remove_route_policy_candidate_fallback migration").toBeDefined();
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
    expect(Object.prototype.hasOwnProperty.call(candidate, "isFallback")).toBe(false);
  });

  it("rowToRoutePolicySnapshots passes through healthStatus: 'healthy'", () => {
    const row = makeCandidateRow({ healthStatus: "healthy" });
    const snapshots = rowToRoutePolicySnapshots([row]);
    const candidate = snapshots[0]?.candidates[0];
    expect(candidate?.healthStatus).toBe("healthy");
    expect(Object.prototype.hasOwnProperty.call(candidate, "isFallback")).toBe(false);
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
                price: { modelId: "gpt-4", priceVersion: "v1", providerKey: "openai", reason: "model_not_in_builtin_registry", status: "unknown_price" },
                providerId: "provider-1",
                providerKey: "openai",
                providerModelId: "model-1",
              },
            ],
          },
        ],
      };
    });

    let capturedHealthNotify:
      | ((payload: HealthSummaryChangedPayload) => void)
      | undefined;
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
});

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

function makePolicy(
  strategy: RoutePolicy["strategy"],
  candidates: RouteCandidate[],
): RoutePolicy {
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
