import {
  calculateTokenCostUsd,
  type ModelTokenPrice,
  type PricedModelTokenPrice,
} from "@llmingress/billing/price-registry";

export const routeEndpointProtocols = [
  "chat_completions",
  "responses",
  "messages",
  "embeddings",
] as const;

export type RouteEndpointProtocol = (typeof routeEndpointProtocols)[number];
export type RoutePolicyStrategy = "fixed" | "cost_first" | "random";

export const modelInputModalities = ["text", "image", "audio", "video", "document"] as const;
export const modelOutputModalities = ["text", "image", "audio", "video", "embedding"] as const;
export const modelCapabilitySyncSources = [
  "provider_models_api",
  "models.dev",
  "openrouter",
  "litellm",
  "vercel-ai-gateway",
] as const;

export type ModelInputModality = (typeof modelInputModalities)[number];
export type ModelOutputModality = (typeof modelOutputModalities)[number];
export type ModelCapabilitySyncSource = (typeof modelCapabilitySyncSources)[number];

export type SyncedModelCapabilities = {
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
};

export type ModelCapabilityField = keyof SyncedModelCapabilities;

export type ModelCapabilityConflictValue = {
  source: ModelCapabilitySyncSource;
  value: unknown;
};

export type ModelCapabilityConflicts = Partial<
  Record<ModelCapabilityField, ModelCapabilityConflictValue[]>
>;

export type ModelCapabilitySources = Partial<
  Record<ModelCapabilityField, ModelCapabilitySyncSource>
>;

export type ProviderModelCapabilityMetadata = {
  conflicts?: ModelCapabilityConflicts;
  manualCapabilities?: Partial<SyncedModelCapabilities>;
  registrySources?: ModelCapabilitySources;
  registrySyncedAt?: string;
  syncedCapabilities?: Partial<SyncedModelCapabilities>;
};

export type ResolvedProviderModelCapabilities = {
  effectiveCapabilities: SyncedModelCapabilities;
  metadata: ProviderModelCapabilityMetadata;
};

export type VirtualModelCapabilityContract = {
  inputModalities: ModelInputModality[];
  outputModalities: ModelOutputModality[];
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsFunctionCalling: boolean;
  supportsReasoning: boolean;
};

export type VirtualModelCapabilityContractCandidate = {
  id: string;
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
};

export type VirtualModelCapabilityContractErrorCode =
  | "route_policy_candidate_capability_incomplete"
  | "route_policy_candidate_capability_mismatch";

export type VirtualModelCapabilityContractResult =
  | {
      contract: VirtualModelCapabilityContract;
      ok: true;
    }
  | {
      code: VirtualModelCapabilityContractErrorCode;
      details: Record<string, unknown>;
      message: string;
      ok: false;
    };

export type VirtualModelRequestCapabilities = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  inputModalities: ModelInputModality[];
  outputModalities: ModelOutputModality[];
  usesFunctionCalling: boolean;
  usesReasoning: boolean;
};

export type VirtualModelRequestCapabilityValidationResult =
  | { ok: true }
  | {
      code: "virtual_model_capability_mismatch";
      details: Record<string, unknown>;
      message: string;
      ok: false;
    };

export const emptySyncedModelCapabilities: SyncedModelCapabilities = {
  inputModalities: null,
  maxContextTokens: null,
  maxOutputTokens: null,
  outputModalities: null,
  supportsFunctionCalling: null,
  supportsReasoning: null,
};

const modelCapabilityFields = [
  "inputModalities",
  "outputModalities",
  "maxContextTokens",
  "maxOutputTokens",
  "supportsFunctionCalling",
  "supportsReasoning",
] as const satisfies readonly ModelCapabilityField[];

export function normalizeModelInputModalities(value: unknown): ModelInputModality[] | null {
  return normalizeModelModalities(value, modelInputModalities, normalizeInputModalityAlias);
}

export function normalizeModelOutputModalities(value: unknown): ModelOutputModality[] | null {
  return normalizeModelModalities(value, modelOutputModalities, normalizeOutputModalityAlias);
}

export function resolveProviderModelCapabilities(input: {
  conflicts?: ModelCapabilityConflicts | null;
  manualCapabilities?: Partial<SyncedModelCapabilities> | null;
  syncedCapabilities?: Partial<SyncedModelCapabilities> | null;
  registrySources?: ModelCapabilitySources | null;
  registrySyncedAt?: string | null;
}): ResolvedProviderModelCapabilities {
  const syncedCapabilities = normalizePartialSyncedModelCapabilities(input.syncedCapabilities);
  const manualCapabilities = normalizePartialSyncedModelCapabilities(input.manualCapabilities);
  const conflicts = input.conflicts ?? {};
  const effectiveCapabilities = { ...emptySyncedModelCapabilities };

  for (const field of modelCapabilityFields) {
    const manual = manualCapabilities[field];
    if (manual !== undefined) {
      setCapabilityField(effectiveCapabilities, field, manual);
      continue;
    }

    if ((conflicts[field]?.length ?? 0) > 0) {
      setCapabilityField(effectiveCapabilities, field, null);
      continue;
    }

    const synced = syncedCapabilities[field];
    setCapabilityField(effectiveCapabilities, field, synced === undefined ? null : synced);
  }

  return {
    effectiveCapabilities,
    metadata: compactProviderModelCapabilityMetadata({
      conflicts,
      manualCapabilities,
      registrySources: input.registrySources ?? undefined,
      registrySyncedAt: input.registrySyncedAt ?? undefined,
      syncedCapabilities,
    }),
  };
}

export function resolveVirtualModelCapabilityContract(
  candidates: readonly VirtualModelCapabilityContractCandidate[],
): VirtualModelCapabilityContractResult {
  const contracts: Array<{
    contract: VirtualModelCapabilityContract;
    providerModelId: string;
  }> = [];

  for (const candidate of candidates) {
    const contract = readVirtualModelCapabilityCandidateContract(candidate);
    if (!contract.ok) {
      return contract;
    }
    contracts.push({
      contract: contract.contract,
      providerModelId: candidate.id,
    });
  }

  const baseline = contracts[0];
  if (!baseline) {
    return {
      code: "route_policy_candidate_capability_incomplete",
      details: { fields: modelCapabilityFields, providerModelId: null },
      message: "Route policy requires at least one provider model with complete capabilities.",
      ok: false,
    };
  }

  for (const candidate of contracts.slice(1)) {
    for (const field of modelCapabilityFields) {
      if (!virtualModelCapabilityFieldEqual(baseline.contract[field], candidate.contract[field])) {
        return {
          code: "route_policy_candidate_capability_mismatch",
          details: {
            referenceProviderModelId: baseline.providerModelId,
            referenceValue: baseline.contract[field],
            field,
            providerModelId: candidate.providerModelId,
            value: candidate.contract[field],
          },
          message: `Route policy candidate capabilities must match for ${field}.`,
          ok: false,
        };
      }
    }
  }

  return { contract: baseline.contract, ok: true };
}

export function validateVirtualModelRequestCapabilities(
  contract: VirtualModelCapabilityContract,
  request: VirtualModelRequestCapabilities,
): VirtualModelRequestCapabilityValidationResult {
  const outputOverflow = request.estimatedOutputTokens > contract.maxOutputTokens;
  if (outputOverflow) {
    return virtualModelCapabilityMismatch("maxOutputTokens", {
      maxOutputTokens: contract.maxOutputTokens,
      requestedOutputTokens: request.estimatedOutputTokens,
    });
  }

  const totalTokens = request.estimatedInputTokens + request.estimatedOutputTokens;
  if (totalTokens > contract.maxContextTokens) {
    return virtualModelCapabilityMismatch("maxContextTokens", {
      maxContextTokens: contract.maxContextTokens,
      requestedTokens: totalTokens,
    });
  }

  const unsupportedInputModalities = request.inputModalities.filter(
    (modality) => !contract.inputModalities.includes(modality),
  );
  if (unsupportedInputModalities.length > 0) {
    return virtualModelCapabilityMismatch("inputModalities", {
      supported: contract.inputModalities,
      unsupported: unsupportedInputModalities,
    });
  }

  const unsupportedOutputModalities = request.outputModalities.filter(
    (modality) => !contract.outputModalities.includes(modality),
  );
  if (unsupportedOutputModalities.length > 0) {
    return virtualModelCapabilityMismatch("outputModalities", {
      supported: contract.outputModalities,
      unsupported: unsupportedOutputModalities,
    });
  }

  if (request.usesFunctionCalling && !contract.supportsFunctionCalling) {
    return virtualModelCapabilityMismatch("supportsFunctionCalling", {
      supported: false,
    });
  }

  if (request.usesReasoning && !contract.supportsReasoning) {
    return virtualModelCapabilityMismatch("supportsReasoning", {
      supported: false,
    });
  }

  return { ok: true };
}

export type RouteCandidateHealthStatus =
  | "healthy"
  | "unknown"
  | "auth_failed"
  | "network_error"
  | "quota_limited"
  | "unhealthy";

export type RouteCandidate = {
  candidateOrder: number;
  displayName: string;
  healthStatus?: RouteCandidateHealthStatus;
  modelId: string;
  price: ModelTokenPrice;
  providerId: string;
  providerKey: string;
  providerModelId: string;
};

export type RoutePolicy<TCandidate extends RouteCandidate = RouteCandidate> = {
  candidates: TCandidate[];
  endpointProtocol?: RouteEndpointProtocol;
  id: string;
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
  candidateExplanations: RouteCandidateExplanation[];
  endpointProtocol?: RouteEndpointProtocol;
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
  random?: () => number;
}): TCandidate[] {
  const { routePolicy, random } = input;

  const sortedCandidates = [...routePolicy.candidates].sort(
    (a, b) => a.candidateOrder - b.candidateOrder,
  );

  // Filter by health status: missing healthStatus treated as "unknown" → eligible
  const healthEligible = sortedCandidates.filter(
    (c) => !INELIGIBLE_HEALTH.has(c.healthStatus ?? "unknown"),
  );

  if (healthEligible.length === 0) {
    return [];
  }

  return routeStrategyHandlers[routePolicy.strategy].orderCandidates(healthEligible, {
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
    random: random ?? Math.random,
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
  const evaluated = allCandidatesSorted.map((candidate) => {
    const eligible = !INELIGIBLE_HEALTH.has(candidate.healthStatus ?? "unknown");
    return {
      candidate,
      eligible,
      reasons: eligible ? [] : [`health status ${candidate.healthStatus} is not eligible`],
    };
  });

  // Build the ordered attempt chain ONCE (single shuffle for random strategy)
  const chain = buildRouteAttemptCandidates({
    routePolicy,
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
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
      endpointProtocol: input.routePolicy.endpointProtocol,
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

function normalizeModelModalities<TModality extends string>(
  value: unknown,
  allowed: readonly TModality[],
  alias: (value: string) => TModality | null,
): TModality[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const seen = new Set<TModality>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const modality = alias(entry);
    if (modality) {
      seen.add(modality);
    }
  }

  const normalized = allowed.filter((entry) => seen.has(entry));
  return normalized.length > 0 ? normalized : null;
}

function normalizeInputModalityAlias(value: string): ModelInputModality | null {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "vision") {
    return "image";
  }
  if (
    normalized === "file" ||
    normalized === "files" ||
    normalized === "pdf" ||
    normalized === "attachment" ||
    normalized === "attachments"
  ) {
    return "document";
  }
  return modelInputModalities.includes(normalized as ModelInputModality)
    ? (normalized as ModelInputModality)
    : null;
}

function normalizeOutputModalityAlias(value: string): ModelOutputModality | null {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "vision") {
    return "image";
  }
  if (normalized === "embeddings") {
    return "embedding";
  }
  return modelOutputModalities.includes(normalized as ModelOutputModality)
    ? (normalized as ModelOutputModality)
    : null;
}

function normalizePartialSyncedModelCapabilities(
  value: Partial<SyncedModelCapabilities> | null | undefined,
): Partial<SyncedModelCapabilities> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return omitUndefined({
    inputModalities:
      value.inputModalities === null
        ? null
        : (normalizeModelInputModalities(value.inputModalities ?? undefined) ?? undefined),
    maxContextTokens:
      value.maxContextTokens === null
        ? null
        : readOptionalPositiveInteger(value.maxContextTokens, "maxContextTokens"),
    maxOutputTokens:
      value.maxOutputTokens === null
        ? null
        : readOptionalPositiveInteger(value.maxOutputTokens, "maxOutputTokens"),
    outputModalities:
      value.outputModalities === null
        ? null
        : (normalizeModelOutputModalities(value.outputModalities ?? undefined) ?? undefined),
    supportsFunctionCalling:
      value.supportsFunctionCalling === null
        ? null
        : readOptionalBoolean(value.supportsFunctionCalling, "supportsFunctionCalling"),
    supportsReasoning:
      value.supportsReasoning === null
        ? null
        : readOptionalBoolean(value.supportsReasoning, "supportsReasoning"),
  });
}

function compactProviderModelCapabilityMetadata(
  metadata: ProviderModelCapabilityMetadata,
): ProviderModelCapabilityMetadata {
  return omitUndefined({
    conflicts: compactCapabilityConflicts(metadata.conflicts),
    manualCapabilities: compactCapabilityObject(metadata.manualCapabilities),
    registrySources:
      metadata.registrySources && Object.keys(metadata.registrySources).length > 0
        ? metadata.registrySources
        : undefined,
    registrySyncedAt: metadata.registrySyncedAt,
    syncedCapabilities: compactCapabilityObject(metadata.syncedCapabilities),
  });
}

function compactCapabilityObject(
  value: Partial<SyncedModelCapabilities> | undefined,
): Partial<SyncedModelCapabilities> | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<SyncedModelCapabilities>;
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function compactCapabilityConflicts(
  conflicts: ModelCapabilityConflicts | undefined,
): ModelCapabilityConflicts | undefined {
  if (!conflicts) {
    return undefined;
  }
  const compacted = Object.fromEntries(
    Object.entries(conflicts).filter(([, values]) => Array.isArray(values) && values.length > 0),
  ) as ModelCapabilityConflicts;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function setCapabilityField(
  target: SyncedModelCapabilities,
  field: ModelCapabilityField,
  value: SyncedModelCapabilities[ModelCapabilityField],
): void {
  switch (field) {
    case "inputModalities":
      target.inputModalities = value as ModelInputModality[] | null;
      return;
    case "outputModalities":
      target.outputModalities = value as ModelOutputModality[] | null;
      return;
    case "maxContextTokens":
      target.maxContextTokens = value as number | null;
      return;
    case "maxOutputTokens":
      target.maxOutputTokens = value as number | null;
      return;
    case "supportsFunctionCalling":
      target.supportsFunctionCalling = value as boolean | null;
      return;
    case "supportsReasoning":
      target.supportsReasoning = value as boolean | null;
      return;
  }
}

function readVirtualModelCapabilityCandidateContract(
  candidate: VirtualModelCapabilityContractCandidate,
): VirtualModelCapabilityContractResult {
  const inputModalities = normalizeModelInputModalities(candidate.inputModalities ?? undefined);
  const outputModalities = normalizeModelOutputModalities(candidate.outputModalities ?? undefined);
  const incompleteFields = [
    ...(inputModalities ? [] : ["inputModalities"]),
    ...(outputModalities ? [] : ["outputModalities"]),
    ...(candidate.maxContextTokens === null ? ["maxContextTokens"] : []),
    ...(candidate.maxOutputTokens === null ? ["maxOutputTokens"] : []),
    ...(candidate.supportsFunctionCalling === null ? ["supportsFunctionCalling"] : []),
    ...(candidate.supportsReasoning === null ? ["supportsReasoning"] : []),
  ];

  if (incompleteFields.length > 0) {
    return {
      code: "route_policy_candidate_capability_incomplete",
      details: {
        fields: incompleteFields,
        providerModelId: candidate.id,
      },
      message: `Route policy candidate ${candidate.id} has incomplete model capabilities.`,
      ok: false,
    };
  }
  if (!inputModalities || !outputModalities) {
    throw new Error("Virtual Model capability modality normalization failed.");
  }

  return {
    contract: {
      inputModalities,
      maxContextTokens: readRequiredPositiveInteger(candidate.maxContextTokens, "maxContextTokens"),
      maxOutputTokens: readRequiredPositiveInteger(candidate.maxOutputTokens, "maxOutputTokens"),
      outputModalities,
      supportsFunctionCalling: readRequiredBoolean(
        candidate.supportsFunctionCalling,
        "supportsFunctionCalling",
      ),
      supportsReasoning: readRequiredBoolean(candidate.supportsReasoning, "supportsReasoning"),
    },
    ok: true,
  };
}

function virtualModelCapabilityFieldEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function virtualModelCapabilityMismatch(
  field: keyof VirtualModelCapabilityContract,
  details: Record<string, unknown>,
): VirtualModelRequestCapabilityValidationResult {
  return {
    code: "virtual_model_capability_mismatch",
    details: { field, ...details },
    message: `Request exceeds Virtual Model capability contract for ${field}.`,
    ok: false,
  };
}

function readRequiredPositiveInteger(value: unknown, field: string): number {
  const normalized = readOptionalPositiveInteger(value, field);
  if (normalized === undefined) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return normalized;
}

function readRequiredBoolean(value: unknown, field: string): boolean {
  const normalized = readOptionalBoolean(value, field);
  if (normalized === undefined) {
    throw new Error(`${field} must be a boolean.`);
  }
  return normalized;
}

function assertTokenEstimate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
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

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

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
