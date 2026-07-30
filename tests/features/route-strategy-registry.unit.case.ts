import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRouteAttemptCandidates,
  isValidRouteTag,
  normalizeRouteTag,
  ROUTE_TAG_DEFAULT,
  type RouteCandidate,
  type RoutePolicy,
  routeStrategyCapabilityContractScope,
  selectRouteAttempts,
} from "../../packages/domain/src/index.ts";

function pricedCandidate(input: {
  candidateOrder: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}): RouteCandidate {
  const modelId = `model-${input.candidateOrder}`;
  return {
    candidateOrder: input.candidateOrder,
    displayName: modelId,
    modelId,
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: input.inputUsdPerMillionTokens,
      modelId,
      outputUsdPerMillionTokens: input.outputUsdPerMillionTokens,
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
  };
}

function unknownPriceCandidate(candidateOrder: number): RouteCandidate {
  const modelId = `model-${candidateOrder}`;
  return {
    candidateOrder,
    displayName: modelId,
    modelId,
    price: {
      modelId,
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: `pm-${candidateOrder}`,
  };
}

function policyWith(strategy: RoutePolicy["strategy"]): RoutePolicy {
  return {
    candidates: [
      pricedCandidate({
        candidateOrder: 1,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 10,
      }),
      pricedCandidate({
        candidateOrder: 2,
        inputUsdPerMillionTokens: 6,
        outputUsdPerMillionTokens: 6,
      }),
    ],
    id: "rp-1",
    strategy,
    virtualModelId: "vm-1",
    virtualModelName: "vm",
  };
}

function taggedCandidate(input: {
  candidateOrder: number;
  tags: readonly string[];
}): RouteCandidate {
  return {
    ...pricedCandidate({
      candidateOrder: input.candidateOrder,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    }),
    tags: input.tags,
  };
}

function tagPolicy(candidates?: RouteCandidate[]): RoutePolicy {
  return {
    candidates: candidates ?? [
      taggedCandidate({ candidateOrder: 1, tags: ["default", "cheap"] }),
      taggedCandidate({ candidateOrder: 2, tags: ["fast"] }),
      taggedCandidate({ candidateOrder: 3, tags: ["long-context"] }),
    ],
    id: "rp-tag",
    strategy: "tag",
    virtualModelId: "vm-1",
    virtualModelName: "vm",
  };
}

function selectTag(requestedTag?: string, routePolicy: RoutePolicy = tagPolicy()) {
  return selectRouteAttempts({
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 1_000,
    requestedTag,
    snapshot: { routePolicies: [routePolicy] },
    virtualModelName: "vm",
  });
}

function select(strategy: RoutePolicy["strategy"]) {
  return selectRouteAttempts({
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 1_000,
    random: () => 0,
    snapshot: { routePolicies: [policyWith(strategy)] },
    virtualModelName: "vm",
  });
}

describe("route strategy registry", () => {
  it("dispatches strategies through a registry, not if-chains", () => {
    const source = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(source).toContain("routeStrategyHandlers");
    expect(source).toContain("Record<RoutePolicyStrategy");
    expect(source.match(/strategy === "/g) ?? []).toEqual([]);
  });

  it("keeps fixed strategy behavior: candidateOrder ascending", () => {
    const result = select("fixed");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.message).toBe(
      "fixed route for vm selected configured candidate 1.",
    );
  });

  it("orders cost_first by input plus output price without token weighting", () => {
    const result = select("cost_first");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
    expect(result.decision?.routeReason.message).toBe(
      "cost_first route for vm selected cheapest eligible candidate 1.",
    );
    expect(result.decision?.routeReason.estimatedCostUsd).toBeUndefined();
    expect(result.decision?.routeReason.priceSource).toBe("manual_override");

    const outputHeavy = selectRouteAttempts({
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1_000_000,
      snapshot: { routePolicies: [policyWith("cost_first")] },
      virtualModelName: "vm",
    });
    expect(outputHeavy.chain.map((candidate) => candidate.candidateOrder)).toEqual([1, 2]);
  });

  it("appends unknown prices in configured order after priced candidates", () => {
    const routePolicy = policyWith("cost_first");
    routePolicy.candidates = [
      unknownPriceCandidate(1),
      pricedCandidate({
        candidateOrder: 2,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 2,
      }),
      unknownPriceCandidate(3),
      pricedCandidate({
        candidateOrder: 4,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      }),
    ];

    const result = selectRouteAttempts({
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      snapshot: { routePolicies: [routePolicy] },
      virtualModelName: "vm",
    });

    expect(result.chain.map((candidate) => candidate.candidateOrder)).toEqual([4, 2, 1, 3]);
  });

  it("keeps load_balance behavior deterministic under injected random", () => {
    // random: () => 0 时 Fisher-Yates 在两候选上必定交换 → [2, 1]
    const result = select("load_balance");
    expect(result.chain.map((c) => c.candidateOrder)).toEqual([2, 1]);
    expect(result.decision?.routeReason.message).toBe(
      "load balance route for vm selected eligible candidate 2.",
    );
  });

  it("orders attempt candidates through the same registry", () => {
    const chain = buildRouteAttemptCandidates({
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      routePolicy: policyWith("cost_first"),
    });
    expect(chain.map((c) => c.candidateOrder)).toEqual([1, 2]);
  });

  it("routes a matched tag to its candidate and keeps only default behind it", () => {
    const result = selectTag("fast");

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([2, 1]);
    expect(result.decision?.routeReason).toMatchObject({
      matchedTag: "fast",
      requestedTag: "fast",
      selectedCandidateOrder: 2,
      strategy: "tag",
      tagFallback: false,
    });
    expect(result.decision?.routeReason.message).toBe(
      'tag route for vm selected candidate 2 for tag "fast".',
    );
  });

  it("falls back to the default candidate when the requested tag matches nothing", () => {
    const result = selectTag("slow");

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1]);
    expect(result.decision?.routeReason).toMatchObject({
      requestedTag: "slow",
      tagFallback: true,
    });
    expect(result.decision?.routeReason.matchedTag).toBeUndefined();
    expect(result.decision?.routeReason.message).toBe(
      'tag route for vm fell back to default candidate 1 because tag "slow" matched no candidate.',
    );
  });

  it("routes a request that names no tag to the default candidate", () => {
    const result = selectTag();

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1]);
    expect(result.decision?.routeReason).toMatchObject({ tagFallback: true });
    expect(result.decision?.routeReason.matchedTag).toBeUndefined();
    expect(result.decision?.routeReason.requestedTag).toBeUndefined();
    expect(result.decision?.routeReason.message).toBe(
      "tag route for vm selected default candidate 1 because the request named no tag.",
    );
  });

  it("does not repeat the default candidate when the requested tag is the default one", () => {
    const result = selectTag(ROUTE_TAG_DEFAULT);

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([1]);
    expect(result.decision?.routeReason).toMatchObject({
      matchedTag: "default",
      requestedTag: "default",
      tagFallback: false,
    });
  });

  it("matches a candidate tag on the normalized requested tag", () => {
    const result = selectTag(" Fast ");

    expect(result.chain.map((c) => c.candidateOrder)).toEqual([2, 1]);
    expect(result.decision?.routeReason).toMatchObject({
      matchedTag: "fast",
      requestedTag: "fast",
    });
  });

  it("fails closed when no candidate carries the default tag", () => {
    const result = selectTag(
      "fast",
      tagPolicy([
        taggedCandidate({ candidateOrder: 1, tags: ["cheap"] }),
        taggedCandidate({ candidateOrder: 2, tags: ["fast"] }),
      ]),
    );

    expect(result).toEqual({ chain: [], decision: undefined });
  });

  it("reports the capability contract scope each strategy checks", () => {
    expect(routeStrategyCapabilityContractScope("fixed")).toBe("all_candidates");
    expect(routeStrategyCapabilityContractScope("cost_first")).toBe("all_candidates");
    expect(routeStrategyCapabilityContractScope("load_balance")).toBe("all_candidates");
    expect(routeStrategyCapabilityContractScope("tag")).toBe("selected_candidate");
  });

  it("normalizes route tags and rejects shapes a header cannot carry safely", () => {
    expect(normalizeRouteTag("  Fast  ")).toBe("fast");
    expect(ROUTE_TAG_DEFAULT).toBe("default");
    expect(isValidRouteTag("default")).toBe(true);
    expect(isValidRouteTag("long-context.v2_1")).toBe(true);
    expect(isValidRouteTag("-leading")).toBe(false);
    expect(isValidRouteTag("has space")).toBe(false);
    expect(isValidRouteTag("Fast")).toBe(false);
    expect(isValidRouteTag("")).toBe(false);
    expect(isValidRouteTag(`a${"b".repeat(63)}`)).toBe(true);
    expect(isValidRouteTag(`a${"b".repeat(64)}`)).toBe(false);
  });
});
