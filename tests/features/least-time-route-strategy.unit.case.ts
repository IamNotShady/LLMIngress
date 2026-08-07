import { describe, expect, it } from "vitest";
import {
  type RouteCandidate,
  type RouteLatencySnapshot,
  type RoutePolicy,
  routeStrategyCapabilityContractScope,
  selectRouteAttempts,
} from "../../packages/domain/src/index.ts";

function latencyCandidate(input: { candidateOrder: number }): RouteCandidate {
  const modelId = `model-${input.candidateOrder}`;
  return {
    candidateOrder: input.candidateOrder,
    displayName: modelId,
    modelId,
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: 1,
      modelId,
      outputUsdPerMillionTokens: 1,
      priceVersion: "test",
      providerKey: "openai",
      snapshotDate: "2026-01-01",
      source: "manual_override",
      sourceUrl: "https://example.com",
      status: "priced",
      unit: "per_1m_tokens",
    },
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: `pm-${input.candidateOrder}`,
    weight: null,
  };
}

function leastTimePolicy(candidates: RouteCandidate[]): RoutePolicy {
  return {
    candidates,
    id: "rp-least-time",
    strategy: "least_time",
    virtualModelId: "vm-1",
    virtualModelName: "vm",
  };
}

function latencySnapshot(input: {
  samples: Array<[string, { ewmaMs: number; lastSampleAtMs?: number; sampleCount?: number }]>;
  exploreRatio?: number;
  minSamples?: number;
  nowMs?: number;
  staleAfterMs?: number;
  tieBucketMs?: number;
}): RouteLatencySnapshot {
  return {
    exploreRatio: input.exploreRatio ?? 0.1,
    minSamples: input.minSamples ?? 5,
    nowMs: input.nowMs ?? 1_000_000,
    samples: new Map(
      input.samples.map(([id, s]) => [
        id,
        {
          ewmaMs: s.ewmaMs,
          lastSampleAtMs: s.lastSampleAtMs ?? 1_000_000,
          sampleCount: s.sampleCount ?? 5,
        },
      ]),
    ),
    staleAfterMs: input.staleAfterMs ?? 1_800_000,
    tieBucketMs: input.tieBucketMs ?? 50,
  };
}

function selectLeastTime(input: {
  candidates: RouteCandidate[];
  random?: () => number;
  routeLatency?: RouteLatencySnapshot;
}) {
  return selectRouteAttempts({
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 1_000,
    random: input.random,
    routeLatency: input.routeLatency,
    snapshot: { routePolicies: [leastTimePolicy(input.candidates)] },
    virtualModelName: "vm",
  });
}

describe("least_time route strategy", () => {
  it("orders warm candidates by ewma ascending", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 1 }),
      latencyCandidate({ candidateOrder: 2 }),
      latencyCandidate({ candidateOrder: 3 }),
    ];
    const result = selectLeastTime({
      candidates,
      random: () => 0.99,
      routeLatency: latencySnapshot({
        samples: [
          ["pm-1", { ewmaMs: 100 }],
          ["pm-2", { ewmaMs: 300 }],
          ["pm-3", { ewmaMs: 50 }],
        ],
      }),
    });

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([3, 1, 2]);
    expect(result.decision?.routeReason.message).toBe(
      "least_time route for vm selected fastest eligible candidate 3.",
    );
  });

  it("breaks ewma ties inside one bucket by candidateOrder", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 1 }),
      latencyCandidate({ candidateOrder: 2 }),
    ];

    // 100 vs 120 both quantize into tie bucket floor(x/50): 2 vs 2 -> same bucket, so
    // candidateOrder decides, keeping candidate 1 first even though its ewma is higher.
    const tied = selectLeastTime({
      candidates,
      random: () => 0.99,
      routeLatency: latencySnapshot({
        samples: [
          ["pm-1", { ewmaMs: 100 }],
          ["pm-2", { ewmaMs: 120 }],
        ],
        tieBucketMs: 50,
      }),
    });
    expect(tied.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);

    // 100 vs 200 quantize into different buckets (2 vs 4), so ewma decides.
    const distinct = selectLeastTime({
      candidates,
      random: () => 0.99,
      routeLatency: latencySnapshot({
        samples: [
          ["pm-1", { ewmaMs: 200 }],
          ["pm-2", { ewmaMs: 100 }],
        ],
        tieBucketMs: 50,
      }),
    });
    expect(distinct.chain.map((c) => c.candidateOrder)).toEqual([2, 1]);
  });

  it("appends cold candidates after warm in configured order", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 1 }),
      latencyCandidate({ candidateOrder: 2 }),
      latencyCandidate({ candidateOrder: 3 }),
    ];
    const result = selectLeastTime({
      candidates,
      random: () => 0.99,
      routeLatency: latencySnapshot({
        minSamples: 5,
        samples: [
          ["pm-2", { ewmaMs: 100, sampleCount: 5 }],
          ["pm-3", { ewmaMs: 10, sampleCount: 1 }],
        ],
      }),
    });

    // pm-2 is the only warm candidate (sampleCount >= minSamples); pm-1 (no
    // sample) and pm-3 (under minSamples) are cold and append in candidateOrder.
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([2, 1, 3]);
  });

  it("treats stale samples as cold", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 1 }),
      latencyCandidate({ candidateOrder: 2 }),
    ];
    const result = selectLeastTime({
      candidates,
      random: () => 0.99,
      routeLatency: latencySnapshot({
        nowMs: 2_000_000,
        samples: [
          // Sample is old enough to exceed staleAfterMs, so it must not keep
          // permanently excluding candidate 1 from ever being retried.
          ["pm-1", { ewmaMs: 5, lastSampleAtMs: 0, sampleCount: 10 }],
          ["pm-2", { ewmaMs: 500, lastSampleAtMs: 2_000_000, sampleCount: 10 }],
        ],
        staleAfterMs: 1_800_000,
      }),
    });

    // pm-1's sample is stale -> cold -> appended after warm pm-2.
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([2, 1]);
  });

  it("promotes one cold candidate under injected random", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 1 }),
      latencyCandidate({ candidateOrder: 2 }),
      latencyCandidate({ candidateOrder: 3 }),
    ];
    const result = selectLeastTime({
      candidates,
      random: () => 0,
      routeLatency: latencySnapshot({
        exploreRatio: 0.1,
        samples: [
          ["pm-1", { ewmaMs: 100, sampleCount: 5 }],
          ["pm-2", { ewmaMs: 200, sampleCount: 5 }],
        ],
      }),
    });

    // pm-3 is the only cold candidate, so it must be the one promoted to the head.
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([3, 1, 2]);
    expect(result.decision?.routeReason.explored).toBe(true);
    expect(result.decision?.routeReason.message).toBe(
      "least_time route for vm selected exploration candidate 3 to gather latency samples.",
    );
  });

  it("skips exploration when random exceeds ratio", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 1 }),
      latencyCandidate({ candidateOrder: 2 }),
    ];
    const result = selectLeastTime({
      candidates,
      random: () => 0.99,
      routeLatency: latencySnapshot({
        exploreRatio: 0.1,
        samples: [["pm-1", { ewmaMs: 100, sampleCount: 5 }]],
      }),
    });

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.explored).toBeUndefined();
  });

  it("degrades to configured order without a latency snapshot", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 2 }),
      latencyCandidate({ candidateOrder: 1 }),
    ];
    const result = selectLeastTime({ candidates, random: () => 0 });

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.explored).toBeUndefined();
    expect(result.decision?.routeReason.message).toBe(
      "least_time route for vm selected fastest eligible candidate 1.",
    );
  });

  it("keeps all-cold policies in configured order", () => {
    const candidates = [
      latencyCandidate({ candidateOrder: 2 }),
      latencyCandidate({ candidateOrder: 1 }),
    ];
    const result = selectLeastTime({
      candidates,
      random: () => 0,
      routeLatency: latencySnapshot({ samples: [] }),
    });

    // No warm candidates at all means nothing to explore against, so the
    // configured order stands and no exploration is annotated.
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.explored).toBeUndefined();
  });

  it("reports all_candidates capability contract scope", () => {
    expect(routeStrategyCapabilityContractScope("least_time")).toBe("all_candidates");
  });
});
