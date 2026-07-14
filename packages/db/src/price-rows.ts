import type { ManualPriceOverride, SyncedPriceSnapshot } from "@llmingress/billing/price-registry";

export type ManualPriceOverrideColumns = {
  cachedInputUsdPerMillionTokens: string | null;
  inputUsdPerMillionTokens: string | null;
  modelId: string;
  outputUsdPerMillionTokens: string | null;
  providerKey: string;
  updatedAt: Date | null;
};

export type SyncedPriceSnapshotColumns = {
  cachedInputUsdPerMillionTokens: string | null;
  inputUsdPerMillionTokens: string | null;
  modelId: string;
  outputUsdPerMillionTokens: string | null;
  priceVersion: string | null;
  providerKey: string;
  sourceUrl: string | null;
  syncedAt: Date | null;
};

export function buildManualPriceOverride(
  columns: ManualPriceOverrideColumns,
): ManualPriceOverride | null {
  if (
    columns.inputUsdPerMillionTokens === null ||
    columns.outputUsdPerMillionTokens === null ||
    columns.updatedAt === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      columns.cachedInputUsdPerMillionTokens === null
        ? null
        : Number(columns.cachedInputUsdPerMillionTokens),
    inputUsdPerMillionTokens: Number(columns.inputUsdPerMillionTokens),
    modelId: columns.modelId,
    outputUsdPerMillionTokens: Number(columns.outputUsdPerMillionTokens),
    providerKey: columns.providerKey,
    updatedAt: columns.updatedAt,
  };
}

export function buildSyncedPriceSnapshot(
  columns: SyncedPriceSnapshotColumns,
): SyncedPriceSnapshot | null {
  if (
    columns.inputUsdPerMillionTokens === null ||
    columns.outputUsdPerMillionTokens === null ||
    columns.priceVersion === null ||
    columns.syncedAt === null
  ) {
    return null;
  }

  return {
    cachedInputUsdPerMillionTokens:
      columns.cachedInputUsdPerMillionTokens === null
        ? null
        : Number(columns.cachedInputUsdPerMillionTokens),
    inputUsdPerMillionTokens: Number(columns.inputUsdPerMillionTokens),
    modelId: columns.modelId,
    outputUsdPerMillionTokens: Number(columns.outputUsdPerMillionTokens),
    priceVersion: columns.priceVersion,
    providerKey: columns.providerKey,
    sourceUrl: columns.sourceUrl,
    syncedAt: columns.syncedAt,
  };
}
