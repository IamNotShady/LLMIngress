import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getPrometheusMetricsDocument } from "../../packages/db/src/gateway-metrics";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-092 prometheus metrics exporter", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("exports gateway worker request latency cost fallback health job metrics without secrets", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_prometheus_metrics_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedPrometheusMetricsData(fixture);

    const document = await getPrometheusMetricsDocument({ databaseUrl: fixture.databaseUrl });

    expect(document.contentType).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(document.body).toContain("# HELP llmingress_gateway_requests_total");
    expect(document.body).toContain(
      'llmingress_gateway_requests_total{protocol="chat_completions",provider="openai",model="gpt-4.1-mini",status="succeeded"} 1',
    );
    expect(document.body).toContain(
      'llmingress_gateway_request_latency_ms_sum{protocol="chat_completions",status="succeeded"} 120',
    );
    expect(document.body).toContain(
      'llmingress_gateway_request_latency_ms_count{protocol="chat_completions",status="succeeded"} 1',
    );
    expect(document.body).toContain(
      'llmingress_gateway_request_cost_usd_total{provider="openai",model="gpt-4.1-mini"} 0.0123',
    );
    expect(document.body).toContain(
      'llmingress_gateway_fallback_events_total{provider="openai",model="gpt-4.1-mini",status="failed",error_code="upstream_timeout"} 1',
    );
    expect(document.body).toContain(
      'llmingress_provider_health_status{provider="openai",model="gpt-4.1-mini",status="quota_limited"} 1',
    );
    expect(document.body).toContain(
      'llmingress_provider_health_consecutive_failures{provider="openai",model="gpt-4.1-mini"} 2',
    );
    expect(document.body).toContain(
      'llmingress_worker_jobs_total{job_type="price_sync",status="succeeded",trigger="scheduled"} 1',
    );
    expect(document.body).toContain(
      'llmingress_worker_job_attempts_total{job_type="price_sync",status="succeeded"} 1',
    );
    expect(document.body).not.toContain("sk-secret-provider-092");
    expect(document.body).not.toContain("llmi_secret092");
    expect(document.body).not.toContain("https://secret-provider.example/v1");
    expect(document.body).not.toContain("sensitive upstream failure");
  });
});

async function seedPrometheusMetricsData(fixture: Fixture): Promise<void> {
  const ids = {
    activityId: randomUUID(),
    agentId: randomUUID(),
    fallbackEventId: randomUUID(),
    failedActivityId: randomUUID(),
    failedJobAttemptId: randomUUID(),
    failedJobId: randomUUID(),
    healthEventId: randomUUID(),
    healthSummaryId: randomUUID(),
    jobAttemptId: randomUUID(),
    jobId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    requestCostId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'sk-secret-provider-092', 'https://secret-provider.example/v1', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'Secret Model 092', 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'metrics-vm', 'Metrics VM', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Metrics Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents
      set key_prefix = 'llmi_secret092',
          key_hash = 'hash-secret-092',
          default_virtual_model_id = $2
      where id = $1
    `,
    [ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        status,
        http_status,
        latency_ms,
        started_at,
        completed_at
      )
      values (
        $1, 'req_metrics_success_092', $2, $3, $4, $5, 'llmi_secret092',
        'chat_completions', 'metrics-vm', false, 'succeeded', 200, 120,
        now() - interval '5 minutes', now() - interval '4 minutes'
      )
    `,
    [ids.activityId, ids.agentId, ids.virtualModelId, ids.providerId, ids.providerModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        status,
        error_code,
        error_message,
        http_status,
        latency_ms,
        started_at,
        completed_at
      )
      values (
        $1, 'req_metrics_failed_092', $2, $3, 'llmi_secret092',
        'responses', 'metrics-vm', false, 'failed', 'provider_error',
        'sensitive upstream failure sk-secret-provider-092', 502, 35,
        now() - interval '3 minutes', now() - interval '2 minutes'
      )
    `,
    [ids.failedActivityId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into request_costs (
        id,
        request_activity_id,
        agent_id,
        provider_model_id,
        total_cost_usd,
        cost_source
      )
      values ($1, $2, $3, $4, 0.01230000, 'estimated')
    `,
    [ids.requestCostId, ids.activityId, ids.agentId, ids.providerModelId],
  );
  await fixture.query(
    `
      insert into fallback_events (
        id,
        request_activity_id,
        provider_model_id,
        attempt_order,
        status,
        error_code,
        error_message,
        failed_before_first_byte
      )
      values ($1, $2, $3, 1, 'failed', 'upstream_timeout', 'sensitive upstream failure', true)
    `,
    [ids.fallbackEventId, ids.activityId, ids.providerModelId],
  );
  await fixture.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        trigger,
        status,
        error_code,
        error_message,
        latency_ms,
        observed_at
      )
      values ($1, $2, $3, 'worker_probe', 'quota_limited', 'upstream_timeout', 'sensitive upstream failure', 42, now())
    `,
    [ids.healthEventId, ids.providerId, ids.providerModelId],
  );
  await fixture.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        last_event_id,
        status,
        consecutive_failures,
        last_failure_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'quota_limited', 2, now(), now())
    `,
    [ids.healthSummaryId, ids.providerId, ids.providerModelId, ids.healthEventId],
  );
  await fixture.query(
    `
      insert into jobs (
        id,
        job_type,
        status,
        trigger,
        payload,
        result,
        completed_at
      )
      values (
        $1, 'price_sync', 'succeeded', 'scheduled',
        '{"apiKey":"sk-secret-provider-092"}'::jsonb,
        '{"ok":true}'::jsonb,
        now()
      )
    `,
    [ids.jobId],
  );
  await fixture.query(
    `
      insert into job_attempts (id, job_id, attempt_number, worker_id, status, result, started_at, finished_at)
      values ($1, $2, 1, 'worker-secret-092', 'succeeded', '{"ok":true}'::jsonb, now() - interval '1 minute', now())
    `,
    [ids.jobAttemptId, ids.jobId],
  );
  await fixture.query(
    `
      insert into jobs (
        id,
        job_type,
        status,
        trigger,
        payload,
        error_code,
        error_message,
        completed_at
      )
      values (
        $1, 'backup', 'failed', 'manual',
        '{"apiKey":"sk-secret-provider-092"}'::jsonb,
        'backup_failed',
        'sensitive upstream failure',
        now()
      )
    `,
    [ids.failedJobId],
  );
  await fixture.query(
    `
      insert into job_attempts (
        id,
        job_id,
        attempt_number,
        worker_id,
        status,
        error_code,
        error_message,
        started_at,
        finished_at
      )
      values (
        $1, $2, 1, 'worker-secret-092', 'failed', 'backup_failed',
        'sensitive upstream failure', now() - interval '1 minute', now()
      )
    `,
    [ids.failedJobAttemptId, ids.failedJobId],
  );
}
