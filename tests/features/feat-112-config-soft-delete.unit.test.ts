import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(import.meta.dirname, "../..");

describe("feat-112 config soft delete for runtime history", () => {
  it("adds config deleted_at columns and request activity label snapshots", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0038" && candidate.name === "config_soft_delete",
    );
    const sql = migration?.sql ?? "";

    for (const table of [
      "agents",
      "providers",
      "provider_models",
      "virtual_models",
      "route_policies",
    ]) {
      expect(sql, table).toContain(`alter table ${table}`);
      expect(sql, table).toContain("add column if not exists deleted_at timestamptz");
    }

    for (const column of [
      "agent_name_snapshot",
      "virtual_model_name_snapshot",
      "route_policy_strategy_snapshot",
      "provider_key_snapshot",
      "provider_display_name_snapshot",
      "provider_model_name_snapshot",
      "provider_model_display_name_snapshot",
    ]) {
      expect(sql).toContain(`add column if not exists ${column} text`);
    }

    expect(sql).toContain("idx_virtual_models_name_active");
    expect(sql).toContain("idx_route_policies_virtual_model_active");
    expect(sql).not.toContain("insert into schema_version");
  });

  it("keeps runtime history foreign keys restrictive", () => {
    const runtimeSchema = readFileSync(
      resolve(root, "packages/db/migrations/0003_runtime_records_jobs_schema.sql"),
      "utf8",
    );

    expect(runtimeSchema).toContain(
      "agent_id uuid not null references agents (id) on delete restrict",
    );
    expect(runtimeSchema).toContain(
      "virtual_model_id uuid references virtual_models (id) on delete restrict",
    );
    expect(runtimeSchema).toContain(
      "route_policy_id uuid references route_policies (id) on delete restrict",
    );
    expect(runtimeSchema).toContain(
      "provider_id uuid references providers (id) on delete restrict",
    );
    expect(runtimeSchema).toContain(
      "provider_model_id uuid references provider_models (id) on delete restrict",
    );
  });

  it("uses soft deletes for Console config deletion", () => {
    const files = [
      "apps/console/src/server/agents.ts",
      "apps/console/src/server/virtual-models.ts",
      "apps/console/src/server/route-policies.ts",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");

      expect(source, file).toContain("deleted_at = now()");
      expect(source, file).not.toMatch(/delete\s+from\s+agents\b/i);
      expect(source, file).not.toMatch(/delete\s+from\s+virtual_models\b/i);
      expect(source, file).not.toMatch(/delete\s+from\s+route_policies\b/i);
    }
  });

  it("filters deleted config from active Gateway reads", () => {
    const authSource = readFileSync(resolve(root, "apps/gateway/src/auth.ts"), "utf8");
    const configReloadSource = readFileSync(
      resolve(root, "apps/gateway/src/config-reload.ts"),
      "utf8",
    );

    expect(authSource).toContain("agents.deleted_at is null");
    for (const filter of [
      "providers.deleted_at is null",
      "provider_models.deleted_at is null",
      "virtual_models.deleted_at is null",
      "route_policies.deleted_at is null",
    ]) {
      expect(configReloadSource).toContain(filter);
    }
  });

  it("uses request snapshots before joined config labels in history readers", () => {
    for (const file of [
      "apps/console/src/server/activity.ts",
      "apps/console/src/server/usage.ts",
      "apps/worker/src/cost-report-export.ts",
      "apps/worker/src/jsonl-export.ts",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");

      expect(source, file).toContain("agent_name_snapshot");
      expect(source, file).toContain("provider_display_name_snapshot");
      expect(source, file).toContain("provider_model_display_name_snapshot");
    }

    const webhookSource = readFileSync(resolve(root, "apps/worker/src/webhook-export.ts"), "utf8");
    expect(webhookSource).toContain("virtual_model_name_snapshot");
    expect(webhookSource).toContain("provider_key_snapshot");
    expect(webhookSource).toContain("provider_model_name_snapshot");
  });
});
