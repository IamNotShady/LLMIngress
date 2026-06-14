import { calculateTokenCostUsd } from "@llmingress/billing/price-registry";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
  GatewayRoutePolicyStrategy,
} from "./config-reload.js";

export type RouteSelectionRequest = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  snapshot: GatewayConfigSnapshot;
  virtualModelId?: string;
  virtualModelName?: string;
};

export type RouteDecision = {
  modelId: string;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  routePolicyId: string;
  routeReason: RouteReason;
  strategy: GatewayRoutePolicyStrategy;
  virtualModelId: string;
  virtualModelName: string;
};

export type RouteReason = {
  estimatedCostUsd?: number;
  message: string;
  priceSource?: "built_in_static_snapshot" | "manual_override";
  selectedCandidateOrder: number;
  strategy: GatewayRoutePolicyStrategy;
};

type CostCandidate = {
  candidate: GatewayRouteCandidateSnapshot;
  estimatedCostUsd: number;
  priceSource: "built_in_static_snapshot" | "manual_override";
};

export function selectRouteCandidate(input: RouteSelectionRequest): RouteDecision {
  assertTokenEstimate(input.estimatedInputTokens, "estimatedInputTokens");
  assertTokenEstimate(input.estimatedOutputTokens, "estimatedOutputTokens");

  const routePolicy = findRoutePolicy(input.snapshot, input);
  const primaryCandidates = routePolicy.candidates
    .filter((candidate) => !candidate.isFallback)
    .sort((left, right) => left.candidateOrder - right.candidateOrder);

  if (primaryCandidates.length === 0) {
    throw new Error(`Route policy ${routePolicy.id} has no primary candidates.`);
  }

  if (routePolicy.strategy === "fixed") {
    const fixedCandidate = requireFirstCandidate(primaryCandidates, routePolicy.id);
    return createDecision({
      candidate: fixedCandidate,
      message: `fixed route for ${routePolicy.virtualModelName} selected configured candidate ${fixedCandidate.candidateOrder}.`,
      routePolicy,
    });
  }

  if (routePolicy.strategy === "cost_first") {
    const cheapest = selectCheapestCandidate(routePolicy, primaryCandidates, input);
    return createDecision({
      candidate: cheapest.candidate,
      estimatedCostUsd: cheapest.estimatedCostUsd,
      message: `cost_first route for ${routePolicy.virtualModelName} selected cheapest eligible candidate ${cheapest.candidate.candidateOrder}.`,
      priceSource: cheapest.priceSource,
      routePolicy,
    });
  }

  const defaultCandidate = requireFirstCandidate(primaryCandidates, routePolicy.id);
  return createDecision({
    candidate: defaultCandidate,
    message: `${routePolicy.strategy} route for ${routePolicy.virtualModelName} selected first primary candidate ${defaultCandidate.candidateOrder}.`,
    routePolicy,
  });
}

function findRoutePolicy(
  snapshot: GatewayConfigSnapshot,
  input: RouteSelectionRequest,
): GatewayRoutePolicySnapshot {
  const routePolicy = snapshot.routePolicies.find((candidate) => {
    if (input.virtualModelId) {
      return candidate.virtualModelId === input.virtualModelId;
    }
    return candidate.virtualModelName === input.virtualModelName;
  });

  if (!routePolicy) {
    const target = input.virtualModelId ?? input.virtualModelName ?? "<missing virtual model>";
    throw new Error(`No route policy found for ${target}.`);
  }

  return routePolicy;
}

function selectCheapestCandidate(
  routePolicy: GatewayRoutePolicySnapshot,
  candidates: GatewayRouteCandidateSnapshot[],
  input: RouteSelectionRequest,
): CostCandidate {
  let cheapest: CostCandidate | undefined;

  for (const candidate of candidates) {
    if (candidate.price.status === "unknown_price") {
      continue;
    }

    const cost = calculateTokenCostUsd(candidate.price, {
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
    });
    if (cost.status !== "estimated") {
      continue;
    }

    const pricedCandidate: CostCandidate = {
      candidate,
      estimatedCostUsd: cost.totalCostUsd,
      priceSource: candidate.price.source,
    };
    if (!cheapest || compareCostCandidate(pricedCandidate, cheapest) < 0) {
      cheapest = pricedCandidate;
    }
  }

  if (!cheapest) {
    throw new Error(`Route policy ${routePolicy.id} has no priced primary candidates.`);
  }

  return cheapest;
}

function requireFirstCandidate(
  candidates: GatewayRouteCandidateSnapshot[],
  routePolicyId: string,
): GatewayRouteCandidateSnapshot {
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error(`Route policy ${routePolicyId} has no primary candidates.`);
  }
  return candidate;
}

function compareCostCandidate(left: CostCandidate, right: CostCandidate): number {
  if (left.estimatedCostUsd !== right.estimatedCostUsd) {
    return left.estimatedCostUsd - right.estimatedCostUsd;
  }
  return left.candidate.candidateOrder - right.candidate.candidateOrder;
}

function createDecision(input: {
  candidate: GatewayRouteCandidateSnapshot;
  estimatedCostUsd?: number;
  message: string;
  priceSource?: "built_in_static_snapshot" | "manual_override";
  routePolicy: GatewayRoutePolicySnapshot;
}): RouteDecision {
  return {
    modelId: input.candidate.modelId,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routePolicy.id,
    routeReason: {
      estimatedCostUsd: input.estimatedCostUsd,
      message: input.message,
      priceSource: input.priceSource,
      selectedCandidateOrder: input.candidate.candidateOrder,
      strategy: input.routePolicy.strategy,
    },
    strategy: input.routePolicy.strategy,
    virtualModelId: input.routePolicy.virtualModelId,
    virtualModelName: input.routePolicy.virtualModelName,
  };
}

function assertTokenEstimate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
}
