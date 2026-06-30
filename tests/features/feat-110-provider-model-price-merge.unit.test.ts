import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(import.meta.dirname, "../..");

describe("feat-110 provider model price merge", () => {
  it("declares synced price fields on provider_models and drops provider_models_price", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0036" && candidate.name === "merge_provider_model_prices",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("alter table provider_models");
    expect(sql).toContain("synced_input_usd_per_million_tokens numeric(20, 8)");
    expect(sql).toContain("synced_cached_input_usd_per_million_tokens numeric(20, 8)");
    expect(sql).toContain("synced_output_usd_per_million_tokens numeric(20, 8)");
    expect(sql).toContain("synced_price_source text");
    expect(sql).toContain("synced_price_source_url text");
    expect(sql).toContain("synced_price_version text");
    expect(sql).toContain("synced_price_synced_at timestamptz");
    expect(sql).toContain("synced_price_metadata jsonb not null default '{}'::jsonb");
    expect(sql).toContain("synced_price_updated_at timestamptz");
    expect(sql).toContain("drop table if exists provider_models_price");
    expect(sql).toContain("values (1, '0036')");
    expect(sql).not.toContain("from provider_models_price");
  });

  it("removes runtime provider_models_price reads and writes", () => {
    const files = [
      "packages/db/src/gateway-config-reload.ts",
      "apps/console/src/server/agent-limits.ts",
      "apps/console/src/server/route-preview.ts",
      "apps/console/src/server/route-policies.ts",
      "apps/worker/src/billing-reconciliation.ts",
      "apps/worker/src/price-sync.ts",
      "apps/worker/src/backup.ts",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");

      expect(source, file).not.toContain("from provider_models_price");
      expect(source, file).not.toContain("insert into provider_models_price");
      expect(source, file).not.toContain('"provider_models_price"');
    }
  });
});
