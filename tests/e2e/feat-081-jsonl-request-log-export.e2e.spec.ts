import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createJsonlRequestLogExportJobHandler } from "../../apps/worker/src/jsonl-export";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("jsonl request log export writes metadata fallback errors without secrets", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_jsonl_request_log_export_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-jsonl-export-"));
  const outputPath = join(outputDir, "request-logs.jsonl");
  const jobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedJsonlExportData(fixture);
    await insertJsonlExportJob(fixture, {
      jobId,
      outputPath,
      requestIds: ["req_jsonl_success_081", "req_jsonl_failure_081"],
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        jsonl_export: createJsonlRequestLogExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T11:00:00.000Z"),
        }),
      },
      workerId: "jsonl-export-worker",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    const rawJsonl = await readFile(outputPath, "utf8");
    expect(rawJsonl).not.toContain("sk-jsonl-provider-secret");
    expect(rawJsonl).not.toContain("ciphertext-jsonl-secret");
    expect(rawJsonl).not.toContain("sha256:v1:jsonl-agent-secret-hash");
    expect(rawJsonl).not.toContain("sk-jsonl-route-secret");
    expect(rawJsonl).not.toContain("sk-jsonl-error-secret");
    expect(rawJsonl).not.toContain("sk-jsonl-fallback-secret");

    const records = rawJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      agent: {
        keyPrefix: "llmi_jsonl81",
        name: "JSONL Export Agent",
        type: "coding",
      },
      error: null,
      fallbackEvents: [],
      provider: {
        key: "jsonl-provider",
      },
      providerModel: {
        modelId: "jsonl-real-model",
      },
      requestId: "req_jsonl_success_081",
      status: "succeeded",
      usage: {
        totalTokens: 15,
      },
    });
    expect(records[1]).toMatchObject({
      error: {
        code: "provider_request_failed",
        httpStatus: 502,
        message: "provider failed with Bearer [REDACTED]",
      },
      fallbackEvents: [
        expect.objectContaining({
          attemptOrder: 1,
          errorCode: "provider_request_failed",
          errorMessage: "fallback failed with [REDACTED]",
          failedBeforeFirstByte: true,
        }),
      ],
      requestId: "req_jsonl_failure_081",
      routeReason: {
        reason: "provider_error",
        secret: "[REDACTED]",
      },
      status: "failed",
    });
    expect(records[1]).toMatchObject({
      cost: null,
      usage: null,
    });

    await expect(readJobResult(fixture, jobId)).resolves.toMatchObject({
      result: {
        exportType: "jsonl_request_logs",
        lineCount: 2,
        outputPath,
      },
      status: "succeeded",
    });
  } finally {
    await fixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type JsonlExportJobInput = {
  jobId: string;
  outputPath: string;
  requestIds: string[];
};

async function seedJsonlExportData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    failureActivityId: randomUUID(),
    providerApiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    routePolicyId: randomUUID(),
    successActivityId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'jsonl-provider', 'JSONL Provider', 'https://jsonl.example/v1', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id, provider_id, model_id, display_name, context_window, supports_streaming,
        supports_tools, availability
      )
      values ($1, $2, 'jsonl-real-model', 'JSONL Real Model', 32000, true, true, 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, 'sk-jsonl', '{"ciphertext":"ciphertext-jsonl-secret"}'::jsonb, 'provider-key-081')
    `,
    [ids.providerApiKeyId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'jsonl-fast', 'JSONL Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
    [ids.routePolicyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, enabled)
      values ($1, 'JSONL Export Agent', 'coding', true)
    `,
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_jsonl81', key_hash = 'sha256:v1:jsonl-agent-secret-hash', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        route_policy_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        route_reason,
        fallback_attempts,
        status,
        http_status,
        latency_ms,
        started_at,
        completed_at,
        created_at
      )
      values (
        $1, 'req_jsonl_success_081', $2, $3, $4, $5, $6, 'llmi_jsonl81',
        'chat_completions', 'jsonl-fast', false, '{"reason":"primary"}'::jsonb,
        '[]'::jsonb, 'succeeded', 200, 320,
        '2026-06-16T10:00:00.000Z'::timestamptz,
        '2026-06-16T10:00:01.000Z'::timestamptz,
        '2026-06-16T10:00:00.000Z'::timestamptz
      )
    `,
    [
      ids.successActivityId,
      ids.agentApiKeyId,
      ids.virtualModelId,
      ids.routePolicyId,
      ids.providerId,
      ids.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        route_policy_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        route_reason,
        fallback_attempts,
        status,
        error_code,
        error_message,
        http_status,
        latency_ms,
        started_at,
        completed_at,
        created_at
      )
      values (
        $1, 'req_jsonl_failure_081', $2, $3, $4, $5, $6, 'llmi_jsonl81',
        'chat_completions', 'jsonl-fast', false,
        '{"reason":"provider_error","secret":"sk-jsonl-route-secret"}'::jsonb,
        '[{"errorCode":"provider_request_failed","apiKey":"sk-jsonl-attempt-secret"}]'::jsonb,
        'failed', 'provider_request_failed',
        'provider failed with Bearer sk-jsonl-error-secret', 502, 1100,
        '2026-06-16T10:00:02.000Z'::timestamptz,
        '2026-06-16T10:00:03.000Z'::timestamptz,
        '2026-06-16T10:00:02.000Z'::timestamptz
      )
    `,
    [
      ids.failureActivityId,
      ids.agentApiKeyId,
      ids.virtualModelId,
      ids.routePolicyId,
      ids.providerId,
      ids.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_usage (
        id,
        request_activity_id,
        agent_id,
        virtual_model_id,
        provider_model_id,
        input_tokens,
        output_tokens,
        total_tokens,
        cached_input_tokens,
        reasoning_tokens,
        token_source
      )
      values ($1, $2, $3, $4, $5, 10, 5, 15, 2, 1, 'provider')
    `,
    [
      randomUUID(),
      ids.successActivityId,
      ids.agentApiKeyId,
      ids.virtualModelId,
      ids.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_costs (
        id,
        request_activity_id,
        agent_id,
        provider_model_id,
        input_cost_usd,
        output_cost_usd,
        total_cost_usd,
        cost_source,
        price_source,
        price_version
      )
      values ($1, $2, $3, $4, 0.0001, 0.0002, 0.0003, 'estimated', 'unit', 'jsonl-v1')
    `,
    [randomUUID(), ids.successActivityId, ids.agentApiKeyId, ids.providerModelId],
  );
  await fixture.query(
    `
      insert into fallback_events (
        id,
        request_activity_id,
        provider_model_id,
        provider_api_key_id,
        attempt_order,
        status,
        error_code,
        error_message,
        failed_before_first_byte
      )
      values (
        $1, $2, $3, $4, 1, 'failed', 'provider_request_failed',
        'fallback failed with sk-jsonl-fallback-secret', true
      )
    `,
    [randomUUID(), ids.failureActivityId, ids.providerModelId, ids.providerApiKeyId],
  );
}

async function insertJsonlExportJob(fixture: Fixture, input: JsonlExportJobInput): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values (
        $1,
        'jsonl_export',
        'pending',
        'manual',
        $2::jsonb,
        1
      )
    `,
    [
      input.jobId,
      JSON.stringify({
        outputPath: input.outputPath,
        requestIds: input.requestIds,
      }),
    ],
  );
}

async function readJobResult(fixture: Fixture, jobId: string) {
  const result = await fixture.query<{ result: unknown; status: string }>(
    "select status, result from jobs where id = $1",
    [jobId],
  );
  return result.rows[0];
}
