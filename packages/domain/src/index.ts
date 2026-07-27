import type { ModelTokenPrice, PricedModelTokenPrice } from "@llmingress/billing/price-registry";
import {
  type RouteEndpointProtocol,
  routeEndpointProtocols,
} from "@llmingress/config/provider-registry";
import { omitUndefined } from "@llmingress/util";

export { type RouteEndpointProtocol, routeEndpointProtocols };
export type RoutePolicyStrategy = "fixed" | "cost_first" | "load_balance";

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

export type ModelCapabilitySources = Partial<
  Record<ModelCapabilityField, ModelCapabilitySyncSource>
>;

export type ProviderModelCapabilityMetadata = {
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
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
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

export type VirtualModelCapabilityContractResult = {
  contract: VirtualModelCapabilityContract;
  ok: true;
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
  manualCapabilities?: Partial<SyncedModelCapabilities> | null;
  syncedCapabilities?: Partial<SyncedModelCapabilities> | null;
  registrySources?: ModelCapabilitySources | null;
  registrySyncedAt?: string | null;
}): ResolvedProviderModelCapabilities {
  const syncedCapabilities = normalizePartialSyncedModelCapabilities(input.syncedCapabilities);
  const manualCapabilities = normalizePartialSyncedModelCapabilities(input.manualCapabilities);
  const effectiveCapabilities = { ...emptySyncedModelCapabilities };

  for (const field of modelCapabilityFields) {
    const manual = manualCapabilities[field];
    if (manual !== undefined) {
      setCapabilityField(effectiveCapabilities, field, manual);
      continue;
    }

    const synced = syncedCapabilities[field];
    setCapabilityField(effectiveCapabilities, field, synced === undefined ? null : synced);
  }

  return {
    effectiveCapabilities,
    metadata: compactProviderModelCapabilityMetadata({
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
  if (candidates.length === 0) {
    throw new Error("Route policy requires at least one provider model.");
  }

  const contracts = candidates.map(readVirtualModelCapabilityCandidateContract);
  const resolved: VirtualModelCapabilityContract = { ...emptySyncedModelCapabilities };

  for (const field of modelCapabilityFields) {
    let reference: VirtualModelCapabilityContract[typeof field] | undefined;
    let shared = true;

    for (const candidate of contracts) {
      const value = candidate[field];
      if (value === null) {
        shared = false;
        break;
      }
      if (reference === undefined) {
        reference = value;
        continue;
      }
      if (!virtualModelCapabilityFieldEqual(reference, value)) {
        shared = false;
        break;
      }
    }

    setCapabilityField(resolved, field, shared && reference !== undefined ? reference : null);
  }

  return { contract: resolved, ok: true };
}

export function validateVirtualModelRequestCapabilities(
  contract: VirtualModelCapabilityContract,
  request: VirtualModelRequestCapabilities,
): VirtualModelRequestCapabilityValidationResult {
  const outputOverflow =
    contract.maxOutputTokens !== null && request.estimatedOutputTokens > contract.maxOutputTokens;
  if (outputOverflow) {
    return virtualModelCapabilityMismatch("maxOutputTokens", {
      maxOutputTokens: contract.maxOutputTokens,
      requestedOutputTokens: request.estimatedOutputTokens,
    });
  }

  const totalTokens = request.estimatedInputTokens + request.estimatedOutputTokens;
  if (contract.maxContextTokens !== null && totalTokens > contract.maxContextTokens) {
    return virtualModelCapabilityMismatch("maxContextTokens", {
      maxContextTokens: contract.maxContextTokens,
      requestedTokens: totalTokens,
    });
  }

  const unsupportedInputModalities = contract.inputModalities
    ? request.inputModalities.filter((modality) => !contract.inputModalities?.includes(modality))
    : [];
  if (unsupportedInputModalities.length > 0) {
    return virtualModelCapabilityMismatch("inputModalities", {
      supported: contract.inputModalities,
      unsupported: unsupportedInputModalities,
    });
  }

  const unsupportedOutputModalities = contract.outputModalities
    ? request.outputModalities.filter((modality) => !contract.outputModalities?.includes(modality))
    : [];
  if (unsupportedOutputModalities.length > 0) {
    return virtualModelCapabilityMismatch("outputModalities", {
      supported: contract.outputModalities,
      unsupported: unsupportedOutputModalities,
    });
  }

  if (request.usesFunctionCalling && contract.supportsFunctionCalling === false) {
    return virtualModelCapabilityMismatch("supportsFunctionCalling", {
      supported: false,
    });
  }

  if (request.usesReasoning && contract.supportsReasoning === false) {
    return virtualModelCapabilityMismatch("supportsReasoning", {
      supported: false,
    });
  }

  return { ok: true };
}

export type RouteCandidate = {
  candidateOrder: number;
  displayName: string;
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
  providerId: string;
  providerKey: string;
  providerModelId: string;
  routePolicyId: string;
  routeReason: RouteReason;
  strategy: RoutePolicyStrategy;
  virtualModelId: string;
  virtualModelName: string;
};

type CostCandidate<TCandidate extends RouteCandidate = RouteCandidate> = {
  candidate: TCandidate;
  combinedPriceUsdPerMillionTokens: number | null;
};

type CandidateEligibility<TCandidate extends RouteCandidate = RouteCandidate> = {
  candidate: TCandidate;
  eligible: boolean;
  reasons: string[];
};

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
  reportsSelectedPrice: boolean;
};

const routeStrategyHandlers: Record<RoutePolicyStrategy, RouteStrategyHandler> = {
  cost_first: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `cost_first route for ${virtualModelName} selected cheapest eligible candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates) =>
      buildCostCandidates(candidates)
        .sort((a, b) => {
          if (a.combinedPriceUsdPerMillionTokens === null) {
            return b.combinedPriceUsdPerMillionTokens === null
              ? a.candidate.candidateOrder - b.candidate.candidateOrder
              : 1;
          }
          if (b.combinedPriceUsdPerMillionTokens === null) {
            return -1;
          }
          if (a.combinedPriceUsdPerMillionTokens !== b.combinedPriceUsdPerMillionTokens) {
            return a.combinedPriceUsdPerMillionTokens - b.combinedPriceUsdPerMillionTokens;
          }
          return a.candidate.candidateOrder - b.candidate.candidateOrder;
        })
        .map((entry) => entry.candidate),
    reportsSelectedPrice: true,
  },
  fixed: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `fixed route for ${virtualModelName} selected configured candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates) => candidates,
    reportsSelectedPrice: false,
  },
  load_balance: {
    decisionMessage: ({ selectedCandidateOrder, virtualModelName }) =>
      `load balance route for ${virtualModelName} selected eligible candidate ${selectedCandidateOrder}.`,
    orderCandidates: (candidates, context) => {
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(context.random() * (i + 1));
        // biome-ignore lint/style/noNonNullAssertion: i and j are valid indices
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      return shuffled;
    },
    reportsSelectedPrice: false,
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

  if (sortedCandidates.length === 0) {
    return [];
  }

  return routeStrategyHandlers[routePolicy.strategy].orderCandidates(sortedCandidates, {
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
  const evaluated = allCandidatesSorted.map((candidate) => ({
    candidate,
    eligible: true,
    reasons: [],
  }));

  // Build the ordered attempt chain ONCE (single shuffle for load_balance strategy)
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
  if (handler.reportsSelectedPrice) {
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
): CostCandidate<TCandidate>[] {
  return candidates.map((candidate) => {
    return {
      candidate,
      combinedPriceUsdPerMillionTokens:
        candidate.price.status === "unknown_price"
          ? null
          : candidate.price.inputUsdPerMillionTokens + candidate.price.outputUsdPerMillionTokens,
    };
  });
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
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routePolicy.id,
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
    virtualModelId: input.routePolicy.virtualModelId,
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
): VirtualModelCapabilityContract {
  const inputModalities = normalizeModelInputModalities(candidate.inputModalities ?? undefined);
  const outputModalities = normalizeModelOutputModalities(candidate.outputModalities ?? undefined);

  return {
    inputModalities,
    maxContextTokens: candidate.maxContextTokens,
    maxOutputTokens: candidate.maxOutputTokens,
    outputModalities,
    supportsFunctionCalling: candidate.supportsFunctionCalling,
    supportsReasoning: candidate.supportsReasoning,
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

export const apiKeyLimitTypes = ["budget", "concurrency", "rpm", "token", "tpm"] as const;
export type ApiKeyLimitType = (typeof apiKeyLimitTypes)[number];

export const apiKeyLimitEnforcementPolicies = ["block", "warn_only"] as const;
export type ApiKeyLimitEnforcementPolicy = (typeof apiKeyLimitEnforcementPolicies)[number];

export const apiKeyLimitPeriods = ["day", "hour", "minute", "month", "request", "week"] as const;
export type ApiKeyLimitPeriod = (typeof apiKeyLimitPeriods)[number];

export const apiKeyLimitUnits = ["requests", "tokens", "usd"] as const;
export type ApiKeyLimitUnit = (typeof apiKeyLimitUnits)[number];
