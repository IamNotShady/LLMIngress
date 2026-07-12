export type PricedModelTokenPrice = {
  cachedInputUsdPerMillionTokens?: number;
  currency: "USD";
  inputUsdPerMillionTokens: number;
  modelId: string;
  outputUsdPerMillionTokens: number;
  priceVersion: string;
  providerKey: string;
  snapshotDate: string;
  source: "manual_override" | "price_sync";
  sourceUrl: string;
  status: "priced";
  unit: "per_1m_tokens";
};

export type UnknownModelTokenPrice = {
  modelId: string;
  priceVersion: string;
  providerKey: string;
  reason: "no_current_price";
  status: "unknown_price";
};

export type ModelTokenPrice = PricedModelTokenPrice | UnknownModelTokenPrice;

export type TokenUsage = {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
};

export type ManualPriceOverride = {
  cachedInputUsdPerMillionTokens?: number | null;
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
      ...(input.manualOverride.cachedInputUsdPerMillionTokens !== null &&
      input.manualOverride.cachedInputUsdPerMillionTokens !== undefined
        ? { cachedInputUsdPerMillionTokens: input.manualOverride.cachedInputUsdPerMillionTokens }
        : {}),
      currency: "USD",
      inputUsdPerMillionTokens: input.manualOverride.inputUsdPerMillionTokens,
      modelId,
      outputUsdPerMillionTokens: input.manualOverride.outputUsdPerMillionTokens,
      priceVersion: `manual:${input.manualOverride.updatedAt.toISOString()}`,
      providerKey,
      snapshotDate: "2026-06-13",
      source: "manual_override",
      sourceUrl: "manual://provider_models",
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

  return {
    modelId,
    priceVersion: "provider-model-current",
    providerKey,
    reason: "no_current_price",
    status: "unknown_price",
  };
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
