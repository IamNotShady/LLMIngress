import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, loadSqlMigrations } from "../../packages/db/src/index";

test("core config schema accepts valid graph and rejects broken references", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_config_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const migrations = loadSqlMigrations();
    const migration = runMigrateCommand(fixture.databaseUrl);
    expect(migration.status, migration.stderr || migration.stdout).toBe(0);
    expect(migration.stdout).toContain(`Applied ${migrations.length} migrations`);

    const graph = await insertValidCoreConfigGraph((text, values) => fixture.query(text, values));

    const coreMigration = await fixture.query<{ count: string }>(
      "select count(*)::text as count from migration_history where id = '0002' and name = 'core_config_schema'",
    );
    expect(coreMigration.rows).toEqual([{ count: "1" }]);

    const counts = await fixture.query<{ table_name: string; row_count: string }>(`
      select 'providers' as table_name, count(*)::text as row_count from providers
      union all
      select 'provider_models', count(*)::text from provider_models
      union all
      select 'agents', count(*)::text from agents
      union all
      select 'virtual_models', count(*)::text from virtual_models
      union all
      select 'agent_virtual_models', count(*)::text from agent_virtual_models
      union all
      select 'route_policies', count(*)::text from route_policies
      union all
      select 'route_policy_candidates', count(*)::text from route_policy_candidates
      union all
      select 'agent_limits', count(*)::text from agent_limits
      union all
      select 'config_versions', count(*)::text from config_versions
      union all
      select 'config_change_events', count(*)::text from config_change_events
      order by table_name
    `);
    expect(counts.rows).toEqual([
      { table_name: "agent_limits", row_count: "1" },
      { table_name: "agents", row_count: "1" },
      { table_name: "agent_virtual_models", row_count: "1" },
      { table_name: "config_change_events", row_count: "1" },
      { table_name: "config_versions", row_count: "1" },
      { table_name: "provider_models", row_count: "1" },
      { table_name: "providers", row_count: "1" },
      { table_name: "route_policies", row_count: "1" },
      { table_name: "route_policy_candidates", row_count: "1" },
      { table_name: "virtual_models", row_count: "1" },
    ]);

    await expectBrokenReference(
      fixture.query(
        "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, $3, $4)",
        [randomUUID(), randomUUID(), "missing-provider-model", "Missing Provider Model"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, $3)",
        [randomUUID(), randomUUID(), "fixed"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order) values ($1, $2, $3, $4)",
        [randomUUID(), randomUUID(), randomUUID(), 1],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
        [randomUUID(), randomUUID()],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), randomUUID(), "rpm", "minute", 60, "requests"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into config_change_events (id, config_version_id, source, changed_table, changed_record_id) values ($1, $2, $3, $4, $5)",
        [randomUUID(), 99_999, "console", "providers", randomUUID()],
      ),
    );

    const extraVirtualModelId = randomUUID();
    await expectBrokenReference(
      fixture.query("update agents set default_virtual_model_id = $2 where id = $1", [
        graph.agentId,
        extraVirtualModelId,
      ]),
    );

    await expectConstraintViolation(
      fixture.query("delete from virtual_models where id = $1", [graph.virtualModelId]),
    );
    await expect(
      fixture.query("delete from agents where id = $1", [graph.agentId]),
    ).resolves.toMatchObject({
      rowCount: 1,
    });
    await expectConstraintViolation(
      fixture.query(
        "insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order, is_fallback) values ($1, $2, $3, $4, $5)",
        [randomUUID(), graph.routePolicyId, graph.providerModelId, 2, true],
      ),
    );
  } finally {
    await fixture.dispose();
  }
});

type Query = Awaited<ReturnType<typeof createTestPostgresFixture>>["query"];

type CoreConfigGraphIds = {
  agentId: string;
  providerModelId: string;
  routePolicyId: string;
  virtualModelId: string;
};

async function insertValidCoreConfigGraph(query: Query): Promise<CoreConfigGraphIds> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const agentId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const routePolicyCandidateId = randomUUID();
  const agentLimitId = randomUUID();
  const configChangeEventId = randomUUID();

  await query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
    [providerId, "api_key", "openai", "OpenAI", true],
  );
  await query(
    "insert into provider_models (id, provider_id, model_id, display_name, context_window, supports_streaming, supports_tools, availability) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [providerModelId, providerId, "gpt-4.1-mini", "GPT-4.1 Mini", 128_000, true, true, "available"],
  );
  await query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, $4)",
    [virtualModelId, "coding-balanced", "Coding Balanced", true],
  );
  await query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, $2, $3, $4, $5, $6, $7)
    `,
    [agentId, "Codex", "coding", "llmi_test", "sha256:test", virtualModelId, true],
  );
  await query("insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, $3)", [
    routePolicyId,
    virtualModelId,
    "fixed",
  ]);
  await query(
    "insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order, is_fallback) values ($1, $2, $3, $4, $5)",
    [routePolicyCandidateId, routePolicyId, providerModelId, 1, false],
  );
  await query("insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)", [
    agentId,
    virtualModelId,
  ]);
  await query(
    "insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled) values ($1, $2, $3, $4, $5, $6, $7)",
    [agentLimitId, agentId, "rpm", "minute", 60, "requests", true],
  );
  const configVersion = await query<{ id: string }>(
    "insert into config_versions (version, source, description) values ($1, $2, $3) returning id::text",
    [1, "console", "Initial config"],
  );
  await query(
    "insert into config_change_events (id, config_version_id, source, changed_table, changed_record_id) values ($1, $2, $3, $4, $5)",
    [configChangeEventId, configVersion.rows[0]?.id, "console", "providers", providerId],
  );

  return {
    agentId,
    providerModelId,
    routePolicyId,
    virtualModelId,
  };
}

async function expectBrokenReference(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: "23503" });
}

async function expectConstraintViolation(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: expect.stringMatching(/^2350[235]$/),
  });
}

function runMigrateCommand(databaseUrl: string) {
  return spawnSync("pnpm", ["run", "db:migrate", "--", "--database-url", databaseUrl], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
}
