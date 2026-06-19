import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { getConsoleUsageSummary } from "../../apps/console/src/server/usage";
import { createCostReportExportJobHandler } from "../../apps/worker/src/cost-report-export";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("cost report export matches usage breakdown totals", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_cost_report_export_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-cost-report-export-"));
  const outputPath = join(outputDir, "cost-report.json");
  const jobId = randomUUID();
  const now = new Date("2026-06-16T12:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedCostReportUsageData(fixture);
    const expectedUsage = await getConsoleUsageSummary({
      databaseUrl: fixture.databaseUrl,
      now,
      window: "24h",
    });
    await insertCostReportExportJob(fixture, {
      jobId,
      outputPath,
      window: "24h",
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        cost_report_export: createCostReportExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      workerId: "cost-report-export-worker",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    const rawReport = await readFile(outputPath, "utf8");
    expect(rawReport).not.toContain("sha256:v1:cost-report-secret-hash");
    const report = JSON.parse(rawReport) as {
      breakdowns: {
        agents: unknown[];
        models: unknown[];
        providerModels: unknown[];
        providers: unknown[];
        virtualModels: unknown[];
      };
      exportType: string;
      summary: Record<string, unknown>;
      window: Record<string, unknown>;
    };

    expect(report).toMatchObject({
      exportType: "cost_report",
      summary: {
        failureCount: expectedUsage.failureCount,
        inputTokens: expectedUsage.inputTokens,
        outputTokens: expectedUsage.outputTokens,
        requestCount: expectedUsage.requestCount,
        totalCostUsd: expectedUsage.totalCostUsd,
        totalSavingsUsd: expectedUsage.totalSavingsUsd,
        totalTokens: expectedUsage.totalTokens,
      },
      window: {
        end: "2026-06-16T12:00:00.000Z",
        label: "24h",
        start: "2026-06-15T12:00:00.000Z",
      },
    });
    expect(report.breakdowns.agents).toEqual(expectedUsage.agentBreakdowns);
    expect(report.breakdowns.providerModels).toEqual(expectedUsage.breakdowns);
    expect(report.breakdowns.virtualModels).toEqual(expectedUsage.virtualModelBreakdowns);
    expect(report.breakdowns.providers).toEqual(expectedUsage.providerBreakdowns);
    expect(report.breakdowns.models).toEqual(expectedUsage.modelBreakdowns);

    await expect(readJobResult(fixture, jobId)).resolves.toMatchObject({
      result: {
        exportType: "cost_report",
        outputPath,
        requestCount: expectedUsage.requestCount,
        totalCostUsd: expectedUsage.totalCostUsd,
      },
      status: "succeeded",
    });
    await expect(readExportTask(fixture, jobId)).resolves.toMatchObject({
      export_type: "cost_report",
      line_count: 1,
      output_path: outputPath,
      status: "succeeded",
    });
  } finally {
    await fixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type CostReportExportJobInput = {
  jobId: string;
  outputPath: string;
  window: "24h" | "7d" | "30d";
};

async function seedCostReportUsageData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    anthropicModelId: randomUUID(),
    anthropicProviderId: randomUUID(),
    oldActivityId: randomUUID(),
    openaiModelId: randomUUID(),
    openaiProviderId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai-cost-report', 'Cost Report OpenAI', 'https://openai.example/v1', true),
             ($2, 'api_key', 'anthropic-cost-report', 'Cost Report Anthropic', 'https://anthropic.example/v1', true)
    `,
    [ids.openaiProviderId, ids.anthropicProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 'available'),
             ($3, $4, 'claude-haiku-4-5', 'Claude Haiku', 'available')
    `,
    [ids.openaiModelId, ids.openaiProviderId, ids.anthropicModelId, ids.anthropicProviderId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'cost-fast', 'Cost Fast', true)
    `,
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Cost Report Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_cost82', key_hash = 'sha256:v1:cost-report-secret-hash', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );

  await insertCostReportRequest(fixture, {
    ...ids,
    costUsd: "0.00100000",
    inputTokens: 100,
    outputTokens: 200,
    providerId: ids.openaiProviderId,
    providerModelId: ids.openaiModelId,
    requestId: "req_cost_report_openai_082",
    savingsUsd: "0.00300000",
    startedAt: "2026-06-16T11:00:00.000Z",
    status: "succeeded",
  });
  await insertCostReportRequest(fixture, {
    ...ids,
    costUsd: "0.00200000",
    inputTokens: 150,
    outputTokens: 250,
    providerId: ids.anthropicProviderId,
    providerModelId: ids.anthropicModelId,
    requestId: "req_cost_report_anthropic_082",
    savingsUsd: "0.00400000",
    startedAt: "2026-06-16T11:05:00.000Z",
    status: "succeeded",
  });
  await insertCostReportRequest(fixture, {
    ...ids,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    providerId: null,
    providerModelId: null,
    requestId: "req_cost_report_failed_082",
    savingsUsd: null,
    startedAt: "2026-06-16T11:10:00.000Z",
    status: "failed",
  });
  await insertCostReportRequest(fixture, {
    ...ids,
    costUsd: "9.00000000",
    inputTokens: 900,
    outputTokens: 900,
    providerId: ids.openaiProviderId,
    providerModelId: ids.openaiModelId,
    requestId: "req_cost_report_old_082",
    savingsUsd: "1.00000000",
    startedAt: "2026-06-14T11:00:00.000Z",
    status: "succeeded",
  });
}

async function insertCostReportRequest(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    costUsd: string | null;
    inputTokens: number;
    outputTokens: number;
    providerId: string | null;
    providerModelId: string | null;
    requestId: string;
    savingsUsd: string | null;
    startedAt: string;
    status: "failed" | "succeeded";
    virtualModelId: string;
  },
): Promise<void> {
  const activityId = randomUUID();
  const totalTokens = input.inputTokens + input.outputTokens;

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
        error_code,
        http_status,
        started_at,
        completed_at,
        created_at
      )
      values (
        $1, $2, $3, $4, $5, $6, 'llmi_cost82', 'chat_completions', 'cost-fast',
        false, $7, case when $7 = 'failed' then 'provider_error' else null end,
        case when $7 = 'failed' then 502 else 200 end,
        $8::timestamptz,
        ($8::timestamptz + interval '1 second'),
        $8::timestamptz
      )
    `,
    [
      activityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      input.providerId,
      input.providerModelId,
      input.status,
      input.startedAt,
    ],
  );

  if (input.status === "succeeded" && input.providerModelId) {
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
          token_source
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'estimated')
      `,
      [
        randomUUID(),
        activityId,
        input.agentApiKeyId,
        input.virtualModelId,
        input.providerModelId,
        input.inputTokens,
        input.outputTokens,
        totalTokens,
      ],
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
        values ($1, $2, $3, $4, $5::numeric, 'estimated')
      `,
      [randomUUID(), activityId, input.agentApiKeyId, input.providerModelId, input.costUsd],
    );
    await fixture.query(
      `
        insert into request_savings (
          id,
          request_activity_id,
          actual_cost_usd,
          baseline_cost_usd,
          savings_usd
        )
        values ($1, $2, $3::numeric, ($3::numeric + $4::numeric), $4::numeric)
      `,
      [randomUUID(), activityId, input.costUsd, input.savingsUsd],
    );
  }
}

async function insertCostReportExportJob(
  fixture: Fixture,
  input: CostReportExportJobInput,
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values (
        $1,
        'cost_report_export',
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
        window: input.window,
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

async function readExportTask(fixture: Fixture, jobId: string) {
  const result = await fixture.query<{
    export_type: string;
    line_count: number;
    output_path: string;
    status: string;
  }>(
    `
      select export_type, status, output_path, line_count
      from export_tasks
      where job_id = $1
    `,
    [jobId],
  );
  return result.rows[0];
}
