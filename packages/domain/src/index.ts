import {
  calculateTokenCostUsd,
  type ModelTokenPrice,
  type PricedModelTokenPrice,
} from "@llmingress/billing/price-registry";

export const routeTaskTypes = [
  "general",
  "coding",
  "repo",
  "terminal",
  "long_context",
  "reasoning",
] as const;
export const routeCapabilities = ["coding", "reasoning", "tools"] as const;

export type RouteTaskType = (typeof routeTaskTypes)[number];
export type RouteCapability = (typeof routeCapabilities)[number];
export type RoutePolicyStrategy = "fixed" | "cost_first" | "quality_first" | "random";

export type RoutePolicyRules = {
  taskTypes?: RouteTaskType[];
  requiredCapabilities?: RouteCapability[];
  maxContextTokens?: number;
  requireTools?: boolean;
  timeoutMs?: number;
  retryAttempts?: number;
};

export type ProviderModelCapabilities = {
  coding?: boolean;
  reasoning?: boolean;
  tools?: boolean;
  maxTimeoutMs?: number;
  retryable?: boolean;
};

export type RouteCandidateHealthStatus =
  | "healthy"
  | "unknown"
  | "auth_failed"
  | "network_error"
  | "quota_limited"
  | "unhealthy";

export type RouteCandidate = {
  candidateOrder: number;
  capabilities?: ProviderModelCapabilities;
  contextWindow?: number | null;
  displayName: string;
  healthStatus?: RouteCandidateHealthStatus;
  modelId: string;
  price: ModelTokenPrice;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  supportsTools?: boolean;
};

export type RoutePolicy = {
  candidates: RouteCandidate[];
  id: string;
  rules?: RoutePolicyRules;
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
  virtualModelName: string;
};

export type RouteSelectionSnapshot = {
  routePolicies: RoutePolicy[];
};

export type RouteSelectionRequest = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  snapshot: RouteSelectionSnapshot;
  taskType?: RouteTaskType;
  usesTools?: boolean;
  virtualModelId?: string;
  virtualModelName?: string;
};

export type RouteCandidateExplanation = {
  candidateOrder: number;
  eligible: boolean;
  providerModelId: string;
  reasons: string[];
};

export type RouteReason = {
  appliedRules: RoutePolicyRules;
  candidateExplanations: RouteCandidateExplanation[];
  estimatedCostUsd?: number;
  message: string;
  priceSource?: PricedModelTokenPrice["source"];
  selectedCandidateOrder: number;
  strategy: RoutePolicyStrategy;
};

export type RouteDecision = {
  modelId: string;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  routePolicyId: string;
  routeReason: RouteReason;
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
  virtualModelName: string;
};

type CostCandidate = {
  candidate: RouteCandidate;
  estimatedCostUsd: number;
  priceSource: PricedModelTokenPrice["source"];
};

type CandidateEligibility = {
  candidate: RouteCandidate;
  eligible: boolean;
  reasons: string[];
};

const INELIGIBLE_HEALTH: ReadonlySet<string> = new Set([
  "unhealthy",
  "auth_failed",
  "quota_limited",
  "network_error",
]);

export function buildRouteAttemptCandidates(input: {
  routePolicy: RoutePolicy;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  taskType?: RouteTaskType;
  usesTools?: boolean;
  random?: () => number;
}): RouteCandidate[] {
  const { routePolicy, random } = input;
  const selectionRequest = {
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    snapshot: { routePolicies: [routePolicy] },
    taskType: input.taskType,
    usesTools: input.usesTools,
  };

  const sortedCandidates = [...routePolicy.candidates].sort(
    (a, b) => a.candidateOrder - b.candidateOrder,
  );

  // Filter by health status: missing healthStatus treated as "unknown" → eligible
  const healthEligible = sortedCandidates.filter(
    (c) => !INELIGIBLE_HEALTH.has(c.healthStatus ?? "unknown"),
  );

  // Filter by rule eligibility via evaluateCandidate
  const ruleEligible = healthEligible.filter((candidate) => {
    const result = evaluateCandidate({ candidate, input: selectionRequest, routePolicy });
    return result.eligible;
  });

  if (ruleEligible.length === 0) {
    return [];
  }

  if (routePolicy.strategy === "fixed") {
    // Already sorted by candidateOrder asc
    return ruleEligible;
  }

  if (routePolicy.strategy === "cost_first") {
    const priced = buildCostCandidates(ruleEligible, selectionRequest);
    return priced
      .sort((a, b) => {
        if (a.estimatedCostUsd !== b.estimatedCostUsd) {
          return a.estimatedCostUsd - b.estimatedCostUsd;
        }
        return a.candidate.candidateOrder - b.candidate.candidateOrder;
      })
      .map((c) => c.candidate);
  }

  if (routePolicy.strategy === "quality_first") {
    const priced = buildCostCandidates(ruleEligible, selectionRequest);
    return priced
      .sort((a, b) => {
        if (a.estimatedCostUsd !== b.estimatedCostUsd) {
          return b.estimatedCostUsd - a.estimatedCostUsd;
        }
        return a.candidate.candidateOrder - b.candidate.candidateOrder;
      })
      .map((c) => c.candidate);
  }

  // random: Fisher–Yates shuffle using provided random function
  const randomFn = random ?? Math.random;
  const shuffled = [...ruleEligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(randomFn() * (i + 1));
    // biome-ignore lint/style/noNonNullAssertion: i and j are valid indices
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

export function normalizeRoutePolicyRules(value: unknown): RoutePolicyRules {
  const record = readOptionalRecord(value, "Route policy rules");
  return omitUndefined({
    maxContextTokens: readOptionalPositiveInteger(record.maxContextTokens, "maxContextTokens"),
    requiredCapabilities: readOptionalEnumArray(
      record.requiredCapabilities,
      routeCapabilities,
      "requiredCapabilities",
      "capability",
    ),
    requireTools: readOptionalBoolean(record.requireTools, "requireTools"),
    retryAttempts: readOptionalNonNegativeInteger(record.retryAttempts, "retryAttempts"),
    taskTypes: readOptionalEnumArray(record.taskTypes, routeTaskTypes, "taskTypes", "task type"),
    timeoutMs: readOptionalPositiveInteger(record.timeoutMs, "timeoutMs"),
  });
}

export function normalizeProviderModelCapabilities(value: unknown): ProviderModelCapabilities {
  const record = readOptionalRecord(value, "Provider model capability metadata");
  return omitUndefined({
    coding: readOptionalBoolean(record.coding, "coding"),
    maxTimeoutMs: readOptionalPositiveInteger(record.maxTimeoutMs, "maxTimeoutMs"),
    reasoning: readOptionalBoolean(record.reasoning, "reasoning"),
    retryable: readOptionalBoolean(record.retryable, "retryable"),
    tools: readOptionalBoolean(record.tools, "tools"),
  });
}

export function selectRouteCandidate(input: RouteSelectionRequest): RouteDecision {
  assertTokenEstimate(input.estimatedInputTokens, "estimatedInputTokens");
  assertTokenEstimate(input.estimatedOutputTokens, "estimatedOutputTokens");

  const routePolicy = findRoutePolicy(input.snapshot, input);

  // Build full evaluated list over ALL candidates (sorted by order) for candidateExplanations
  const allCandidatesSorted = [...routePolicy.candidates].sort(
    (a, b) => a.candidateOrder - b.candidateOrder,
  );
  const evaluated = allCandidatesSorted.map((candidate) =>
    evaluateCandidate({ candidate, input, routePolicy }),
  );

  // Get the ordered attempt chain (head = selected candidate)
  const chain = buildRouteAttemptCandidates({
    routePolicy,
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    taskType: input.taskType,
    usesTools: input.usesTools,
  });

  if (chain.length === 0) {
    throw new Error(`Route policy ${routePolicy.id} has no eligible candidates.`);
  }

  // Head of chain = selected candidate
  // biome-ignore lint/style/noNonNullAssertion: chain.length > 0 checked above
  const selectedCandidate = chain[0]!;

  if (routePolicy.strategy === "fixed") {
    return createDecision({
      candidate: selectedCandidate,
      evaluated,
      message: `fixed route for ${routePolicy.virtualModelName} selected configured candidate ${selectedCandidate.candidateOrder}.`,
      routePolicy,
    });
  }

  if (routePolicy.strategy === "cost_first") {
    // Compute cost for the selected candidate for the decision's estimatedCostUsd
    const costResult = calculateTokenCostUsd(selectedCandidate.price, {
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
    });
    const estimatedCostUsd = costResult.status === "estimated" ? costResult.totalCostUsd : undefined;
    const priceSource =
      selectedCandidate.price.status !== "unknown_price"
        ? selectedCandidate.price.source
        : undefined;
    return createDecision({
      candidate: selectedCandidate,
      estimatedCostUsd,
      evaluated,
      message: `cost_first route for ${routePolicy.virtualModelName} selected cheapest eligible candidate ${selectedCandidate.candidateOrder}.`,
      priceSource,
      routePolicy,
    });
  }

  if (routePolicy.strategy === "quality_first") {
    const costResult = calculateTokenCostUsd(selectedCandidate.price, {
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
    });
    const estimatedCostUsd = costResult.status === "estimated" ? costResult.totalCostUsd : undefined;
    const priceSource =
      selectedCandidate.price.status !== "unknown_price"
        ? selectedCandidate.price.source
        : undefined;
    return createDecision({
      candidate: selectedCandidate,
      estimatedCostUsd,
      evaluated,
      message: `quality_first route for ${routePolicy.virtualModelName} selected highest-priced eligible candidate ${selectedCandidate.candidateOrder}.`,
      priceSource,
      routePolicy,
    });
  }

  return createDecision({
    candidate: selectedCandidate,
    evaluated,
    message: `random route for ${routePolicy.virtualModelName} selected eligible candidate ${selectedCandidate.candidateOrder}.`,
    routePolicy,
  });
}

function findRoutePolicy(
  snapshot: RouteSelectionSnapshot,
  input: RouteSelectionRequest,
): RoutePolicy {
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

function evaluateCandidate(input: {
  candidate: RouteCandidate;
  input: RouteSelectionRequest;
  routePolicy: RoutePolicy;
}): CandidateEligibility {
  const totalEstimatedTokens = input.input.estimatedInputTokens + input.input.estimatedOutputTokens;
  const rules = input.routePolicy.rules ?? {};
  const reasons: string[] = [];

  if (
    input.input.taskType &&
    rules.taskTypes &&
    rules.taskTypes.length > 0 &&
    !rules.taskTypes.includes(input.input.taskType)
  ) {
    reasons.push(`task type ${input.input.taskType} is not allowed by route policy`);
  }
  if (rules.maxContextTokens !== undefined) {
    if (totalEstimatedTokens > rules.maxContextTokens) {
      reasons.push(
        `estimated tokens ${totalEstimatedTokens} exceed policy max context ${rules.maxContextTokens}`,
      );
    }
    if (
      input.candidate.contextWindow !== undefined &&
      input.candidate.contextWindow !== null &&
      totalEstimatedTokens > input.candidate.contextWindow
    ) {
      reasons.push(
        `estimated tokens ${totalEstimatedTokens} exceed model context window ${input.candidate.contextWindow}`,
      );
    }
  }
  if (rules.requireTools && input.candidate.supportsTools !== true) {
    reasons.push("request uses tools but model does not support tools");
  }

  const missingCapabilities = (rules.requiredCapabilities ?? []).filter(
    (capability) => !candidateHasCapability(input.candidate, capability),
  );
  if (missingCapabilities.length > 0) {
    reasons.push(`missing required capabilities: ${missingCapabilities.join(", ")}`);
  }
  if (
    rules.timeoutMs !== undefined &&
    input.candidate.capabilities?.maxTimeoutMs !== undefined &&
    rules.timeoutMs > input.candidate.capabilities.maxTimeoutMs
  ) {
    reasons.push(
      `policy timeout ${rules.timeoutMs}ms exceeds model max timeout ${input.candidate.capabilities.maxTimeoutMs}ms`,
    );
  }
  if (
    rules.retryAttempts !== undefined &&
    rules.retryAttempts > 0 &&
    input.candidate.capabilities?.retryable !== true
  ) {
    reasons.push("policy retry attempts require retryable model");
  }

  return {
    candidate: input.candidate,
    eligible: reasons.length === 0,
    reasons,
  };
}

function candidateHasCapability(candidate: RouteCandidate, capability: RouteCapability): boolean {
  if (capability === "tools") {
    return candidate.supportsTools === true || candidate.capabilities?.tools === true;
  }
  return candidate.capabilities?.[capability] === true;
}

function buildCostCandidates(
  candidates: RouteCandidate[],
  input: { estimatedInputTokens: number; estimatedOutputTokens: number },
): CostCandidate[] {
  const result: CostCandidate[] = [];
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
    result.push({
      candidate,
      estimatedCostUsd: cost.totalCostUsd,
      priceSource: candidate.price.source,
    });
  }
  return result;
}

function createDecision(input: {
  candidate: RouteCandidate;
  estimatedCostUsd?: number;
  evaluated: CandidateEligibility[];
  message: string;
  priceSource?: PricedModelTokenPrice["source"];
  routePolicy: RoutePolicy;
}): RouteDecision {
  return {
    modelId: input.candidate.modelId,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routePolicy.id,
    routeReason: {
      appliedRules: input.routePolicy.rules ?? {},
      candidateExplanations: input.evaluated.map((evaluated) => ({
        candidateOrder: evaluated.candidate.candidateOrder,
        eligible: evaluated.eligible,
        providerModelId: evaluated.candidate.providerModelId,
        reasons:
          evaluated.candidate.providerModelId === input.candidate.providerModelId
            ? [`selected by ${input.routePolicy.strategy} strategy`]
            : evaluated.eligible
              ? [`eligible but not selected by ${input.routePolicy.strategy} strategy`]
              : evaluated.reasons,
      })),
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

function readOptionalRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function readOptionalEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
  label: string,
): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }

  const result: T[] = [];
  for (const entry of value) {
    if (!allowed.includes(entry as T)) {
      throw new Error(`${name} contains invalid ${label}.`);
    }
    if (!result.includes(entry as T)) {
      result.push(entry as T);
    }
  }
  return result;
}

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
