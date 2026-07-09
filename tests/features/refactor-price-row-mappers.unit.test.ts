import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildManualPriceOverride,
  buildSyncedPriceSnapshot,
} from "../../packages/db/src/price-rows.ts";

const formerMapperFiles = [
  "packages/db/src/gateway-config-reload.ts",
  "packages/db/src/console-route-policies.ts",
  "packages/db/src/console-agent-limits.ts",
  "packages/db/src/worker-billing-reconciliation.ts",
  "packages/db/src/console-price-overrides.ts",
  "packages/db/src/console-route-preview.ts",
];

describe("refactor-price-row-mappers", () => {
  it("defines the mappers once and only once", () => {
    for (const file of formerMapperFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("function rowToManualPriceOverride");
      expect(source).not.toContain("function rowToSyncedPriceSnapshot");
    }
  });

  it("builds a manual override from text columns", () => {
    const updatedAt = new Date("2026-01-01T00:00:00Z");
    expect(
      buildManualPriceOverride({
        cachedInputUsdPerMillionTokens: "0.5",
        inputUsdPerMillionTokens: "2",
        modelId: "m1",
        outputUsdPerMillionTokens: "8",
        providerKey: "openai",
        updatedAt,
      }),
    ).toEqual({
      cachedInputUsdPerMillionTokens: 0.5,
      inputUsdPerMillionTokens: 2,
      modelId: "m1",
      outputUsdPerMillionTokens: 8,
      providerKey: "openai",
      updatedAt,
    });
  });

  it("returns null when any required override column is null", () => {
    expect(
      buildManualPriceOverride({
        cachedInputUsdPerMillionTokens: null,
        inputUsdPerMillionTokens: null,
        modelId: "m1",
        outputUsdPerMillionTokens: "8",
        providerKey: "openai",
        updatedAt: new Date(),
      }),
    ).toBeNull();
  });

  it("builds a synced snapshot and returns null on missing columns", () => {
    const syncedAt = new Date("2026-01-02T00:00:00Z");
    expect(
      buildSyncedPriceSnapshot({
        cachedInputUsdPerMillionTokens: null,
        inputUsdPerMillionTokens: "1",
        modelId: "m1",
        outputUsdPerMillionTokens: "3",
        priceVersion: "v1",
        providerKey: "openai",
        sourceUrl: null,
        syncedAt,
      }),
    ).toEqual({
      cachedInputUsdPerMillionTokens: null,
      inputUsdPerMillionTokens: 1,
      modelId: "m1",
      outputUsdPerMillionTokens: 3,
      priceVersion: "v1",
      providerKey: "openai",
      sourceUrl: null,
      syncedAt,
    });
    expect(
      buildSyncedPriceSnapshot({
        cachedInputUsdPerMillionTokens: null,
        inputUsdPerMillionTokens: "1",
        modelId: "m1",
        outputUsdPerMillionTokens: "3",
        priceVersion: null,
        providerKey: "openai",
        sourceUrl: null,
        syncedAt,
      }),
    ).toBeNull();
  });
});
