import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, loadSqlMigrations } from "../../packages/db/src/index";

test("runtime schema persists activity usage reservations jobs health and gateway status with required indexes", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_runtime_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const migration = runMigrateCommand(fixture.databaseUrl);
    expect(migration.status, migration.stderr || migration.stdout).toBe(0);
    expect(migration.stdout).toContain(`Applied ${loadSqlMigrations().length} migrations`);

    const graph = await insertValidCoreConfigGraph((text, values) => fixture.query(text, values));
    const runtime = await insertValidRuntimeRecords(
      (text, values) => fixture.query(text, values),
      graph,
    );

    const runtimeMigration = await fixture.query<{ count: string }>(
      "select count(*)::text as count from migration_history where id = '0003' and name = 'runtime_records_jobs_schema'",
    );
    expect(runtimeMigration.rows).toEqual([{ count: "1" }]);

    const counts = await fixture.query<{ table_name: string; row_count: string }>(`
      select 'request_activity' as table_name, count(*)::text as row_count from request_activity
      union all
      select 'request_usage', count(*)::text from request_usage
      union all
      select 'budget_reservations', count(*)::text from budget_reservations
      union all
      select 'jobs', count(*)::text from jobs
      union all
      select 'job_attempts', count(*)::text from job_attempts
      union all
      select 'provider_health_events', count(*)::text from provider_health_events
      union all
      select 'gateway_runtime_status', count(*)::text from gateway_runtime_status
      order by table_name
    `);
    expect(counts.rows).toEqual([
      { table_name: "budget_reservations", row_count: "1" },
      { table_name: "gateway_runtime_status", row_count: "1" },
      { table_name: "job_attempts", row_count: "1" },
      { table_name: "jobs", row_count: "1" },
      { table_name: "provider_health_events", row_count: "1" },
      { table_name: "request_activity", row_count: "1" },
      { table_name: "request_usage", row_count: "1" },
    ]);

    await expectBrokenReference(
      fixture.query(
        "insert into request_activity (id, request_id, agent_api_key_id, agent_api_key_prefix, protocol, status) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), "req_bad_key", randomUUID(), "llmi_bad", "chat_completions", "succeeded"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into request_usage (id, request_activity_id, agent_api_key_id, input_tokens, output_tokens, total_tokens, token_source) values ($1, $2, $3, $4, $5, $6, $7)",
        [randomUUID(), randomUUID(), graph.agentApiKeyId, 1, 1, 2, "estimated"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into budget_reservations (id, agent_api_key_id, budget_period_id, status, reserved_input_tokens, reserved_output_tokens, reserved_cost_usd, expires_at) values ($1, $2, $3, $4, $5, $6, $7, now())",
        [randomUUID(), graph.agentApiKeyId, randomUUID(), "pending", 1, 1, 0.01],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into job_attempts (id, job_id, attempt_number, worker_id, status) values ($1, $2, $3, $4, $5)",
        [randomUUID(), randomUUID(), 1, "worker-test", "running"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into provider_health_events (id, provider_id, provider_model_id, job_id, trigger, status) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), graph.providerId, graph.providerModelId, randomUUID(), "manual", "healthy"],
      ),
    );

    await expectConstraintViolation(
      fixture.query(
        "insert into budget_reservations (id, agent_api_key_id, budget_period_id, status, reserved_input_tokens, reserved_output_tokens, reserved_cost_usd, expires_at) values ($1, $2, $3, $4, $5, $6, $7, now())",
        [randomUUID(), graph.agentApiKeyId, runtime.budgetPeriodId, "pending", -1, 1, 0.01],
      ),
    );
    await expectConstraintViolation(
      fixture.query(
        "insert into jobs (id, job_type, status, trigger, payload) values ($1, $2, $3, $4, $5)",
        [randomUUID(), "model_refresh", "not-a-status", "manual", "{}"],
      ),
    );
    await expectConstraintViolation(
      fixture.query(
        "insert into jobs (id, job_type, status, trigger, payload, lease_owner) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), "model_refresh", "pending", "manual", "{}", "worker-without-expiry"],
      ),
    );

    const largeTokenCount = "2147483648";
    const largeBudgetPeriod = await fixture.query<{
      reserved_tokens: string;
      tokens_used: string;
    }>(
      "insert into budget_periods (id, agent_api_key_id, period_type, period_start, period_end, tokens_used, reserved_tokens) values ($1, $2, $3, timestamp '2026-01-01', timestamp '2026-02-01', $4, $5) returning tokens_used::text, reserved_tokens::text",
      [randomUUID(), graph.agentApiKeyId, "month", largeTokenCount, largeTokenCount],
    );
    expect(largeBudgetPeriod.rows).toEqual([
      { tokens_used: largeTokenCount, reserved_tokens: largeTokenCount },
    ]);

    const wrongProviderId = randomUUID();
    await fixture.query(
      "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
      [wrongProviderId, "api_key", "anthropic", "Anthropic", true],
    );
    await expectBrokenReference(
      fixture.query(
        "insert into request_activity (id, request_id, agent_api_key_id, virtual_model_id, route_policy_id, provider_id, provider_model_id, agent_api_key_prefix, protocol, model, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [
          randomUUID(),
          "req_wrong_provider_model",
          graph.agentApiKeyId,
          graph.virtualModelId,
          graph.routePolicyId,
          wrongProviderId,
          graph.providerModelId,
          "llmi_runtime",
          "chat_completions",
          "coding-balanced",
          "failed",
        ],
      ),
    );

    await fixture.query(
      "insert into provider_health_summary (id, provider_id, provider_model_id, status) values ($1, $2, $3, $4)",
      [randomUUID(), graph.providerId, null, "healthy"],
    );
    await expectConstraintViolation(
      fixture.query(
        "insert into provider_health_summary (id, provider_id, provider_model_id, status) values ($1, $2, $3, $4)",
        [randomUUID(), graph.providerId, null, "degraded"],
      ),
    );
    await expectBrokenReference(
      fixture.query(
        "insert into provider_health_summary (id, provider_id, provider_model_id, status) values ($1, $2, $3, $4)",
        [randomUUID(), wrongProviderId, graph.providerModelId, "degraded"],
      ),
    );

    const indexes = await fixture.query<{ indexname: string }>(`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'idx_request_activity_agent_created_at',
          'idx_request_activity_virtual_model_created_at',
          'idx_request_usage_agent_created_at',
          'idx_budget_reservations_pending_expires_at',
          'idx_jobs_pending_run_after',
          'idx_jobs_running_lease_expires_at',
          'idx_provider_health_events_provider_observed_at',
          'idx_provider_health_events_model_observed_at',
          'idx_gateway_runtime_status_heartbeat_at',
          'idx_runtime_errors_process_created_at'
        )
      order by indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "idx_budget_reservations_pending_expires_at",
      "idx_gateway_runtime_status_heartbeat_at",
      "idx_jobs_pending_run_after",
      "idx_jobs_running_lease_expires_at",
      "idx_provider_health_events_model_observed_at",
      "idx_provider_health_events_provider_observed_at",
      "idx_request_activity_agent_created_at",
      "idx_request_activity_virtual_model_created_at",
      "idx_request_usage_agent_created_at",
      "idx_runtime_errors_process_created_at",
    ]);
  } finally {
    await fixture.dispose();
  }
});

type Query = Awaited<ReturnType<typeof createTestPostgresFixture>>["query"];

type CoreConfigGraphIds = {
  agentApiKeyId: string;
  providerId: string;
  providerModelId: string;
  routePolicyId: string;
  virtualModelId: string;
};

type RuntimeRecordIds = {
  budgetPeriodId: string;
};

async function insertValidCoreConfigGraph(query: Query): Promise<CoreConfigGraphIds> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const agentId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const routePolicyCandidateId = randomUUID();
  const agentApiKeyId = randomUUID();

  await query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
    [providerId, "api_key", "openai", "OpenAI", true],
  );
  await query(
    "insert into provider_models (id, provider_id, model_id, display_name, context_window, supports_streaming, supports_tools, availability) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [providerModelId, providerId, "gpt-4.1-mini", "GPT-4.1 Mini", 128_000, true, true, "available"],
  );
  await query("insert into agents (id, name, agent_type, enabled) values ($1, $2, $3, $4)", [
    agentId,
    "Codex",
    "coding",
    true,
  ]);
  await query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, $2, $3, $4)",
    [virtualModelId, "coding-balanced", "Coding Balanced", true],
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
  await query(
    "insert into agent_api_keys (id, agent_id, key_prefix, key_hash, default_virtual_model_id, enabled) values ($1, $2, $3, $4, $5, $6)",
    [agentApiKeyId, agentId, "llmi_runtime", "sha256:runtime", virtualModelId, true],
  );
  await query(
    "insert into agent_api_key_virtual_models (agent_api_key_id, virtual_model_id) values ($1, $2)",
    [agentApiKeyId, virtualModelId],
  );
  await query("insert into config_versions (version, source, description) values ($1, $2, $3)", [
    1,
    "console",
    "Runtime schema E2E config",
  ]);

  return {
    agentApiKeyId,
    providerId,
    providerModelId,
    routePolicyId,
    virtualModelId,
  };
}

async function insertValidRuntimeRecords(
  query: Query,
  graph: CoreConfigGraphIds,
): Promise<RuntimeRecordIds> {
  const requestActivityId = randomUUID();
  const requestUsageId = randomUUID();
  const budgetPeriodId = randomUUID();
  const budgetReservationId = randomUUID();
  const jobId = randomUUID();
  const jobAttemptId = randomUUID();
  const providerHealthEventId = randomUUID();
  const gatewayRuntimeStatusId = randomUUID();

  await query(
    "insert into request_activity (id, request_id, agent_api_key_id, virtual_model_id, route_policy_id, provider_id, provider_model_id, agent_api_key_prefix, protocol, model, stream, route_reason, status, http_status, latency_ms) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
    [
      requestActivityId,
      "req_runtime_1",
      graph.agentApiKeyId,
      graph.virtualModelId,
      graph.routePolicyId,
      graph.providerId,
      graph.providerModelId,
      "llmi_runtime",
      "chat_completions",
      "coding-balanced",
      false,
      JSON.stringify({ reason: "fixed model" }),
      "succeeded",
      200,
      123,
    ],
  );
  await query(
    "insert into request_usage (id, request_activity_id, agent_api_key_id, virtual_model_id, provider_model_id, input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens, token_source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    [
      requestUsageId,
      requestActivityId,
      graph.agentApiKeyId,
      graph.virtualModelId,
      graph.providerModelId,
      10,
      5,
      15,
      0,
      0,
      "provider",
    ],
  );
  await query(
    "insert into budget_periods (id, agent_api_key_id, period_type, period_start, period_end, tokens_used, cost_used_usd, reserved_tokens, reserved_cost_usd) values ($1, $2, $3, now(), now() + interval '1 day', $4, $5, $6, $7)",
    [budgetPeriodId, graph.agentApiKeyId, "day", 15, 0.00001, 15, 0.00001],
  );
  await query(
    "insert into budget_reservations (id, agent_api_key_id, budget_period_id, request_activity_id, status, reserved_input_tokens, reserved_output_tokens, reserved_cost_usd, actual_total_tokens, actual_cost_usd, expires_at, finalized_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + interval '5 minutes', now())",
    [
      budgetReservationId,
      graph.agentApiKeyId,
      budgetPeriodId,
      requestActivityId,
      "finalized",
      10,
      5,
      0.00001,
      15,
      0.00001,
    ],
  );
  await query(
    "insert into jobs (id, job_type, status, trigger, payload, result, run_after, attempt_count, max_attempts) values ($1, $2, $3, $4, $5, $6, now(), $7, $8)",
    [
      jobId,
      "provider_connectivity_check",
      "succeeded",
      "manual",
      JSON.stringify({ providerId: graph.providerId }),
      JSON.stringify({ ok: true }),
      1,
      3,
    ],
  );
  await query(
    "insert into job_attempts (id, job_id, attempt_number, worker_id, status, result, finished_at) values ($1, $2, $3, $4, $5, $6, now())",
    [jobAttemptId, jobId, 1, "worker-test", "succeeded", JSON.stringify({ ok: true })],
  );
  await query(
    "insert into provider_health_events (id, provider_id, provider_model_id, job_id, trigger, status, latency_ms, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      providerHealthEventId,
      graph.providerId,
      graph.providerModelId,
      jobId,
      "manual",
      "healthy",
      42,
      JSON.stringify({ probe: "chat" }),
    ],
  );
  await query(
    "insert into gateway_runtime_status (id, gateway_instance_id, status, applied_config_version, target_config_version, last_reload_status, heartbeat_at, started_at) values ($1, $2, $3, $4, $5, $6, now(), now())",
    [gatewayRuntimeStatusId, "gateway-test", "ready", 1, 1, "succeeded"],
  );

  return { budgetPeriodId };
}

async function expectBrokenReference(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: "23503" });
}

async function expectConstraintViolation(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: expect.stringMatching(/^2350[235]$|^23514$/),
  });
}

function runMigrateCommand(databaseUrl: string) {
  return spawnSync("pnpm", ["run", "db:migrate", "--", "--database-url", databaseUrl], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
}
