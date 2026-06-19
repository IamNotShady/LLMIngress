import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-074 billing reconciliation job", () => {
  it("keeps reconciliation results on request cost and savings rows without audit tables", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0015" && candidate.name === "billing_reconciliation",
    );

    expect(migration?.sql).toContain("values (1, '0015')");
    expect(migration?.sql).not.toContain("billing_reconciliation_runs");
    expect(migration?.sql).not.toContain("billing_reconciliation_items");
    expect(migration?.sql).not.toContain("idx_billing_reconciliation_items_request");
  });

  it("registers billing reconciliation in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createBillingReconciliationJobHandler");
    expect(workerMain).toContain("billing_reconciliation:");
  });

  it("does not write reconciliation runs or item ledgers", () => {
    const handlerSource = readFileSync(
      resolve(root, "apps/worker/src/billing-reconciliation.ts"),
      "utf8",
    );
    const backupSource = readFileSync(resolve(root, "apps/worker/src/backup.ts"), "utf8");

    expect(handlerSource).not.toContain("billing_reconciliation_runs");
    expect(handlerSource).not.toContain("billing_reconciliation_items");
    expect(backupSource).not.toContain("billing_reconciliation_runs");
    expect(backupSource).not.toContain("billing_reconciliation_items");
  });

  it("builds provider and price-data reconciliation updates", async () => {
    const { buildBillingReconciliationUpdate } = await import(
      "../../apps/worker/src/billing-reconciliation"
    );

    expect(
      buildBillingReconciliationUpdate({
        baselineCostUsd: 0.01,
        currentCost: {
          costSource: "estimated",
          inputCostUsd: 0.0001,
          outputCostUsd: 0.0002,
          priceSource: "built_in_static_snapshot",
          priceVersion: "stale",
          totalCostUsd: 0.0003,
        },
        price: {
          cachedInputUsdPerMillionTokens: 0.5,
          currency: "USD",
          inputUsdPerMillionTokens: 2,
          modelId: "synced-model",
          outputUsdPerMillionTokens: 4,
          priceVersion: "price-sync:reconcile-v1",
          providerKey: "synced-provider",
          snapshotDate: "2026-06-16",
          source: "price_sync",
          sourceUrl: "test://prices",
          status: "priced",
          unit: "per_1m_tokens",
        },
        providerCost: null,
        usage: {
          cachedInputTokens: 400,
          inputTokens: 1_000,
          outputTokens: 500,
        },
      }),
    ).toMatchObject({
      itemStatus: "updated",
      newCost: {
        costSource: "reconciled",
        inputCostUsd: 0.0014,
        outputCostUsd: 0.002,
        priceSource: "price_sync",
        priceVersion: "price-sync:reconcile-v1",
        totalCostUsd: 0.0034,
      },
      newSavings: {
        actualCostUsd: 0.0034,
        savingsPercent: 66,
        savingsUsd: 0.0066,
      },
      reconciliationSource: "price_data",
    });

    expect(
      buildBillingReconciliationUpdate({
        baselineCostUsd: 0.01,
        currentCost: {
          costSource: "estimated",
          inputCostUsd: 0.0001,
          outputCostUsd: 0.0002,
          priceSource: "built_in_static_snapshot",
          priceVersion: "stale",
          totalCostUsd: 0.0003,
        },
        price: null,
        providerCost: {
          inputCostUsd: 0.0007,
          outputCostUsd: 0.0009,
          priceSource: "provider_billing",
          priceVersion: "provider-bill:2026-06-16",
          totalCostUsd: 0.0016,
        },
        usage: {
          cachedInputTokens: 0,
          inputTokens: 100,
          outputTokens: 200,
        },
      }),
    ).toMatchObject({
      itemStatus: "updated",
      newCost: {
        costSource: "provider",
        inputCostUsd: 0.0007,
        outputCostUsd: 0.0009,
        priceSource: "provider_billing",
        priceVersion: "provider-bill:2026-06-16",
        totalCostUsd: 0.0016,
      },
      newSavings: {
        actualCostUsd: 0.0016,
        savingsPercent: 84,
        savingsUsd: 0.0084,
      },
      reconciliationSource: "provider_actual",
    });
  });
});
