export const BUILT_IN_PRICE_REGISTRY_VERSION = "mvp-static-2026-06-13";

export type PriceProviderKey = "anthropic" | "openai";

export type PricedModelTokenPrice = {
  cachedInputUsdPerMillionTokens?: number;
  currency: "USD";
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  priceVersion: string;
  providerKey: string;
  snapshotDate: string;
  source: "built_in_static_snapshot" | "manual_override" | "price_sync";
  sourceUrl: string;
  status: "priced";
  unit: "per_1m_tokens";
};

export type UnknownModelTokenPrice = {
  modelId: string;
  priceVersion: typeof BUILT_IN_PRICE_REGISTRY_VERSION;
  providerKey: string;
  reason: "model_not_in_builtin_registry";
  status: "unknown_price";
};

export type ModelTokenPrice = PricedModelTokenPrice | UnknownModelTokenPrice;

export type TokenUsage = {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
};

export type ManualPriceOverride = {
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  providerKey: string;
  updatedAt: Date;
};

export type SyncedPriceSnapshot = {
  cachedInputUsdPerMillionTokens?: number | null;
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  priceVersion: string;
  providerKey: string;
  sourceUrl?: string | null;
  syncedAt: Date;
};

export type EstimatedTokenCost = {
  inputCostUsd: number;
  outputCostUsd: number;
  status: "estimated";
  totalCostUsd: number;
};

export type UnavailableTokenCost = {
  reason: "unknown_price";
  status: "unavailable";
};

type PriceRegistryEntry = Omit<
  PricedModelTokenPrice,
  "modelId" | "priceVersion" | "snapshotDate" | "source" | "status" | "unit"
>;

const priceRegistry = new Map<string, PriceRegistryEntry>(
  [
    openai("gpt-4.1", 2, 8, "https://developers.openai.com/api/docs/models/gpt-4.1"),
    openai("gpt-4.1-2025-04-14", 2, 8, "https://developers.openai.com/api/docs/models/gpt-4.1"),
    openai("gpt-4.1-mini", 0.4, 1.6, "https://developers.openai.com/api/docs/models/gpt-4.1-mini"),
    openai(
      "gpt-4.1-mini-2025-04-14",
      0.4,
      1.6,
      "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
    ),
    openai("gpt-4.1-nano", 0.1, 0.4, "https://developers.openai.com/api/docs/models/gpt-4.1-nano"),
    openai(
      "gpt-4.1-nano-2025-04-14",
      0.1,
      0.4,
      "https://developers.openai.com/api/docs/models/gpt-4.1-nano",
    ),
    anthropic(
      "claude-fable-5",
      10,
      50,
      "https://platform.claude.com/docs/en/about-claude/models/overview",
    ),
    anthropic(
      "claude-opus-4-8",
      5,
      25,
      "https://platform.claude.com/docs/en/about-claude/models/overview",
    ),
    anthropic(
      "claude-sonnet-4-6",
      3,
      15,
      "https://platform.claude.com/docs/en/about-claude/models/overview",
    ),
    anthropic(
      "claude-haiku-4-5",
      1,
      5,
      "https://platform.claude.com/docs/en/about-claude/models/overview",
    ),
    anthropic(
      "claude-haiku-4-5-20251001",
      1,
      5,
      "https://platform.claude.com/docs/en/about-claude/models/overview",
    ),
  ].map((entry) => [registryKey(entry.providerKey, entry.modelId), entry]),
);

export function resolveModelTokenPrice(input: {
  modelId: string;
  providerKey: string;
}): ModelTokenPrice {
  const providerKey = input.providerKey.trim().toLowerCase();
  const modelId = input.modelId.trim();
  const entry = priceRegistry.get(registryKey(providerKey, modelId));

  if (!entry) {
    return {
      modelId,
      priceVersion: BUILT_IN_PRICE_REGISTRY_VERSION,
      providerKey,
      reason: "model_not_in_builtin_registry",
      status: "unknown_price",
    };
  }

  return {
    ...entry,
    modelId,
    priceVersion: BUILT_IN_PRICE_REGISTRY_VERSION,
    snapshotDate: "2026-06-13",
    source: "built_in_static_snapshot",
    status: "priced",
    unit: "per_1m_tokens",
  };
}

export function listBuiltInModelTokenPrices(): PricedModelTokenPrice[] {
  return [...priceRegistry.entries()]
    .map(([key, entry]) => {
      const separatorIndex = key.indexOf(":");
      const modelId = separatorIndex === -1 ? key : key.slice(separatorIndex + 1);
      return {
        ...entry,
        modelId,
        priceVersion: BUILT_IN_PRICE_REGISTRY_VERSION,
        snapshotDate: "2026-06-13",
        source: "built_in_static_snapshot" as const,
        status: "priced" as const,
        unit: "per_1m_tokens" as const,
      };
    })
    .sort((left, right) =>
      `${left.providerKey}:${left.modelId}`.localeCompare(`${right.providerKey}:${right.modelId}`),
    );
}

export function resolveEffectiveModelTokenPrice(input: {
  manualOverride?: ManualPriceOverride | null;
  modelId: string;
  providerKey: string;
  syncedPrice?: SyncedPriceSnapshot | null;
}): ModelTokenPrice {
  const providerKey = input.providerKey.trim().toLowerCase();
  const modelId = input.modelId.trim();

  if (matchesManualOverride(input.manualOverride, providerKey, modelId)) {
    return {
      currency: "USD",
      inputUsdPerMillionTokens: input.manualOverride.inputUsdPerMillionTokens,
      modelId,
      outputUsdPerMillionTokens: input.manualOverride.outputUsdPerMillionTokens,
      priceVersion: `manual:${input.manualOverride.updatedAt.toISOString()}`,
      providerKey,
      snapshotDate: "2026-06-13",
      source: "manual_override",
      sourceUrl: "manual://console/model-price-overrides",
      status: "priced",
      unit: "per_1m_tokens",
    };
  }

  if (matchesSyncedPrice(input.syncedPrice, providerKey, modelId)) {
    return {
      ...(input.syncedPrice.cachedInputUsdPerMillionTokens !== null &&
      input.syncedPrice.cachedInputUsdPerMillionTokens !== undefined
        ? { cachedInputUsdPerMillionTokens: input.syncedPrice.cachedInputUsdPerMillionTokens }
        : {}),
      currency: "USD",
      inputUsdPerMillionTokens: input.syncedPrice.inputUsdPerMillionTokens,
      modelId,
      outputUsdPerMillionTokens: input.syncedPrice.outputUsdPerMillionTokens,
      priceVersion: input.syncedPrice.priceVersion,
      providerKey,
      snapshotDate: input.syncedPrice.syncedAt.toISOString().slice(0, 10),
      source: "price_sync",
      sourceUrl: input.syncedPrice.sourceUrl ?? "price-sync://snapshot",
      status: "priced",
      unit: "per_1m_tokens",
    };
  }

  return resolveModelTokenPrice({ modelId, providerKey });
}

export function calculateTokenCostUsd(
  price: ModelTokenPrice,
  usage: TokenUsage,
): EstimatedTokenCost | UnavailableTokenCost {
  if (price.status === "unknown_price") {
    return {
      reason: "unknown_price",
      status: "unavailable",
    };
  }

  const cachedInputTokens = clampCachedInputTokens(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncachedInputTokens = usage.inputTokens - cachedInputTokens;
  const cachedInputPrice = price.cachedInputUsdPerMillionTokens ?? price.inputUsdPerMillionTokens;
  const inputCostUsd = roundUsd(
    costFromTokens(uncachedInputTokens, price.inputUsdPerMillionTokens) +
      costFromTokens(cachedInputTokens, cachedInputPrice),
  );
  const outputCostUsd = costFromTokens(usage.outputTokens, price.outputUsdPerMillionTokens);

  return {
    inputCostUsd,
    outputCostUsd,
    status: "estimated",
    totalCostUsd: roundUsd(inputCostUsd + outputCostUsd),
  };
}

function openai(
  modelId: string,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
  sourceUrl: string,
): PriceRegistryEntry & { modelId: string } {
  return {
    cachedInputUsdPerMillionTokens: inputUsdPerMillionTokens / 4,
    currency: "USD",
    inputUsdPerMillionTokens,
    modelId,
    outputUsdPerMillionTokens,
    providerKey: "openai",
    sourceUrl,
  };
}

function anthropic(
  modelId: string,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
  sourceUrl: string,
): PriceRegistryEntry & { modelId: string } {
  return {
    currency: "USD",
    inputUsdPerMillionTokens,
    modelId,
    outputUsdPerMillionTokens,
    providerKey: "anthropic",
    sourceUrl,
  };
}

function registryKey(providerKey: string, modelId: string): string {
  return `${providerKey}:${modelId}`;
}

function matchesManualOverride(
  manualOverride: ManualPriceOverride | null | undefined,
  providerKey: string,
  modelId: string,
): manualOverride is ManualPriceOverride {
  return (
    manualOverride?.providerKey.trim().toLowerCase() === providerKey &&
    manualOverride.modelId.trim() === modelId
  );
}

function matchesSyncedPrice(
  syncedPrice: SyncedPriceSnapshot | null | undefined,
  providerKey: string,
  modelId: string,
): syncedPrice is SyncedPriceSnapshot {
  return (
    syncedPrice?.providerKey.trim().toLowerCase() === providerKey &&
    syncedPrice.modelId.trim() === modelId
  );
}

function costFromTokens(tokens: number, usdPerMillionTokens: number): number {
  return roundUsd((tokens * usdPerMillionTokens) / 1_000_000);
}

function clampCachedInputTokens(cachedInputTokens: number, inputTokens: number): number {
  if (!Number.isFinite(cachedInputTokens) || cachedInputTokens <= 0) {
    return 0;
  }
  return Math.min(Math.floor(cachedInputTokens), inputTokens);
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
