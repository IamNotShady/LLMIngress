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
export const routeEndpointProtocols = [
  "chat_completions",
  "responses",
  "messages",
  "embeddings",
] as const;

export type RouteTaskType = (typeof routeTaskTypes)[number];
export type RouteCapability = (typeof routeCapabilities)[number];
export type RouteEndpointProtocol = (typeof routeEndpointProtocols)[number];
export type RoutePolicyStrategy = "fixed" | "cost_first" | "quality_first" | "random";

export type RoutePolicyRules = {
  endpointProtocol?: RouteEndpointProtocol;
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

export type RoutePolicy<TCandidate extends RouteCandidate = RouteCandidate> = {
  candidates: TCandidate[];
  id: string;
  rules?: RoutePolicyRules;
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
  virtualModelName: string;
};

export type RouteSelectionSnapshot<TCandidate extends RouteCandidate = RouteCandidate> = {
  routePolicies: RoutePolicy<TCandidate>[];
};

export type RouteSelectionRequest<TCandidate extends RouteCandidate = RouteCandidate> = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  snapshot: RouteSelectionSnapshot<TCandidate>;
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
  providerId: ProviderId;
  providerKey: string;
  providerModelId: ProviderModelId;
  routePolicyId: RoutePolicyId;
  routeReason: RouteReason;
  strategy: RoutePolicyStrategy;
  virtualModelId: VirtualModelId;
  virtualModelName: string;
};

type CostCandidate<TCandidate extends RouteCandidate = RouteCandidate> = {
  candidate: TCandidate;
  estimatedCostUsd: number;
  priceSource: PricedModelTokenPrice["source"];
};

type CandidateEligibility<TCandidate extends RouteCandidate = RouteCandidate> = {
  candidate: TCandidate;
  eligible: boolean;
  reasons: string[];
};

const INELIGIBLE_HEALTH: ReadonlySet<string> = new Set([
  "unhealthy",
  "auth_failed",
  "quota_limited",
  "network_error",
]);

type RouteStrategyContext = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  random: () => number;
};

type RouteStrategyHandler = {
  decisionMessage: (input: { selectedCandidateOrder: number; virtualModelName: string }) => string;
  orderCandidates: <TCandidate extends RouteCandidate>(
    candidates: TCandidate[],
    context: RouteStrategyContext,
  ) => TCandidate[];
  usesEstimatedCost: boolean;
};

const routeStrategyHandlers: Record<RoutePolicyStrategy, RouteStrategyHandler> = {
  cost_first: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `cost_first route for ${virtualModelName} selected cheapest eligible candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates, context) =>
      buildCostCandidates(candidates, context)
        .sort((a, b) => {
          if (a.estimatedCostUsd !== b.estimatedCostUsd) {
            return a.estimatedCostUsd - b.estimatedCostUsd;
          }
          return a.candidate.candidateOrder - b.candidate.candidateOrder;
        })
        .map((entry) => entry.candidate),
    usesEstimatedCost: true,
  },
  fixed: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `fixed route for ${virtualModelName} selected configured candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates) => candidates,
    usesEstimatedCost: false,
  },
  quality_first: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `quality_first route for ${virtualModelName} selected highest-priced eligible candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates, context) =>
      buildCostCandidates(candidates, context)
        .sort((a, b) => {
          if (a.estimatedCostUsd !== b.estimatedCostUsd) {
            return b.estimatedCostUsd - a.estimatedCostUsd;
          }
          return a.candidate.candidateOrder - b.candidate.candidateOrder;
        })
        .map((entry) => entry.candidate),
    usesEstimatedCost: true,
  },
  random: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `random route for ${virtualModelName} selected eligible candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates, context) => {
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(context.random() * (i + 1));
        // biome-ignore lint/style/noNonNullAssertion: i and j are valid indices
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      return shuffled;
    },
    usesEstimatedCost: false,
  },
};

export function buildRouteAttemptCandidates<TCandidate extends RouteCandidate>(input: {
  routePolicy: RoutePolicy<TCandidate>;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  taskType?: RouteTaskType;
  usesTools?: boolean;
  random?: () => number;
}): TCandidate[] {
  const { routePolicy, random } = input;
  const selectionRequest: RouteSelectionRequest<TCandidate> = {
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

  return routeStrategyHandlers[routePolicy.strategy].orderCandidates(ruleEligible, {
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    random: random ?? Math.random,
  });
}

export function normalizeRoutePolicyRules(value: unknown): RoutePolicyRules {
  const record = readOptionalRecord(value, "Route policy rules");
  return omitUndefined({
    endpointProtocol: readOptionalEnum(
      record.endpointProtocol,
      routeEndpointProtocols,
      "endpointProtocol",
      "endpoint protocol",
    ),
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

export function selectRouteAttempts<TCandidate extends RouteCandidate>(
  input: RouteSelectionRequest<TCandidate> & { random?: () => number },
): {
  decision: RouteDecision | undefined;
  chain: TCandidate[];
} {
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

  // Build the ordered attempt chain ONCE (single shuffle for random strategy)
  const chain = buildRouteAttemptCandidates({
    routePolicy,
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    taskType: input.taskType,
    usesTools: input.usesTools,
    random: input.random,
  });

  if (chain.length === 0) {
    return { decision: undefined, chain: [] };
  }

  // Head of chain = selected candidate
  // biome-ignore lint/style/noNonNullAssertion: chain.length > 0 checked above
  const selectedCandidate = chain[0]!;

  const handler = routeStrategyHandlers[routePolicy.strategy];
  let estimatedCostUsd: number | undefined;
  let priceSource: PricedModelTokenPrice["source"] | undefined;
  if (handler.usesEstimatedCost) {
    const costResult = calculateTokenCostUsd(selectedCandidate.price, {
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
    });
    estimatedCostUsd = costResult.status === "estimated" ? costResult.totalCostUsd : undefined;
    priceSource =
      selectedCandidate.price.status !== "unknown_price"
        ? selectedCandidate.price.source
        : undefined;
  }

  return {
    chain,
    decision: createDecision({
      candidate: selectedCandidate,
      estimatedCostUsd,
      evaluated,
      message: handler.decisionMessage({
        selectedCandidateOrder: selectedCandidate.candidateOrder,
        virtualModelName: routePolicy.virtualModelName,
      }),
      priceSource,
      routePolicy,
    }),
  };
}

export function selectRouteCandidate<TCandidate extends RouteCandidate>(
  input: RouteSelectionRequest<TCandidate>,
): RouteDecision {
  const r = selectRouteAttempts(input);
  if (!r.decision) {
    const routePolicy = findRoutePolicy(input.snapshot, input);
    throw new Error(`Route policy ${routePolicy.id} has no eligible candidates.`);
  }
  return r.decision;
}

function findRoutePolicy<TCandidate extends RouteCandidate>(
  snapshot: RouteSelectionSnapshot<TCandidate>,
  input: RouteSelectionRequest<TCandidate>,
): RoutePolicy<TCandidate> {
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

function evaluateCandidate<TCandidate extends RouteCandidate>(input: {
  candidate: TCandidate;
  input: RouteSelectionRequest<TCandidate>;
  routePolicy: RoutePolicy<TCandidate>;
}): CandidateEligibility<TCandidate> {
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

function buildCostCandidates<TCandidate extends RouteCandidate>(
  candidates: TCandidate[],
  input: { estimatedInputTokens: number; estimatedOutputTokens: number },
): CostCandidate<TCandidate>[] {
  const result: CostCandidate<TCandidate>[] = [];
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

function createDecision<TCandidate extends RouteCandidate>(input: {
  candidate: TCandidate;
  estimatedCostUsd?: number;
  evaluated: CandidateEligibility<TCandidate>[];
  message: string;
  priceSource?: PricedModelTokenPrice["source"];
  routePolicy: RoutePolicy<TCandidate>;
}): RouteDecision {
  return {
    modelId: input.candidate.modelId,
    providerId: asProviderId(input.candidate.providerId),
    providerKey: input.candidate.providerKey,
    providerModelId: asProviderModelId(input.candidate.providerModelId),
    routePolicyId: asRoutePolicyId(input.routePolicy.id),
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
    virtualModelId: asVirtualModelId(input.routePolicy.virtualModelId),
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

function readOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
  label: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} contains invalid ${label}.`);
  }
  return value as T;
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

export const notificationChannelTypes = ["webhook"] as const;
export type NotificationChannelType = (typeof notificationChannelTypes)[number];

export const agentLimitTypes = ["budget", "concurrency", "rpm", "token", "tpm"] as const;
export type AgentLimitType = (typeof agentLimitTypes)[number];

export const agentLimitEnforcementPolicies = ["block", "warn_only"] as const;
export type AgentLimitEnforcementPolicy = (typeof agentLimitEnforcementPolicies)[number];

export const agentLimitPeriods = ["day", "hour", "minute", "month", "request", "week"] as const;
export type AgentLimitPeriod = (typeof agentLimitPeriods)[number];

export const agentLimitUnits = ["requests", "tokens", "usd"] as const;
export type AgentLimitUnit = (typeof agentLimitUnits)[number];

declare const brandSymbol: unique symbol;

export type Brand<TValue, TBrand extends string> = TValue & {
  readonly [brandSymbol]: TBrand;
};

export type RoutePolicyId = Brand<string, "RoutePolicyId">;
export type VirtualModelId = Brand<string, "VirtualModelId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ProviderModelId = Brand<string, "ProviderModelId">;

export function asRoutePolicyId(value: string): RoutePolicyId {
  return value as RoutePolicyId;
}

export function asVirtualModelId(value: string): VirtualModelId {
  return value as VirtualModelId;
}

export function asProviderId(value: string): ProviderId {
  return value as ProviderId;
}

export function asProviderModelId(value: string): ProviderModelId {
  return value as ProviderModelId;
}
