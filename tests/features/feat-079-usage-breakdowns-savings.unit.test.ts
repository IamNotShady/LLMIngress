import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatConsoleUsageBreakdownStats,
  formatConsoleUsageCost,
  getConsoleUsageSummary,
} from "../../apps/console/src/server/usage";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-079 usage breakdowns and savings", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("aggregates agent virtual model provider model failures cost and savings", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_usage_breakdowns_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedUsageBreakdownData(fixture);

    const summary = await getConsoleUsageSummary({
      databaseUrl: fixture.databaseUrl,
      now: new Date("2026-06-16T12:00:00.000Z"),
      window: "24h",
    });

    expect(summary).toMatchObject({
      failureCount: 1,
      inputTokens: 150,
      outputTokens: 300,
      requestCount: 3,
      totalCostUsd: "0.00150000",
      totalSavingsUsd: "0.00400000",
      totalTokens: 450,
    });
    expect(summary.agentBreakdowns.map(selectBreakdownFields)).toEqual([
      {
        failureCount: 1,
        id: "00000000-0000-4000-8000-000000000079",
        label: "Codex Usage",
        requestCount: 3,
        totalCostUsd: "0.00150000",
        totalSavingsUsd: "0.00400000",
        totalTokens: 450,
      },
    ]);
    expect(summary.virtualModelBreakdowns.map(selectBreakdownFields)).toEqual([
      {
        failureCount: 1,
        id: "00000000-0000-4000-8000-000000000279",
        label: "Usage Fast (usage-fast)",
        requestCount: 3,
        totalCostUsd: "0.00150000",
        totalSavingsUsd: "0.00400000",
        totalTokens: 450,
      },
    ]);
    expect(summary.providerBreakdowns.map(selectBreakdownFields)).toEqual([
      {
        failureCount: 0,
        id: "00000000-0000-4000-8000-000000000379",
        label: "Usage OpenAI",
        requestCount: 1,
        totalCostUsd: "0.00050000",
        totalSavingsUsd: "0.00200000",
        totalTokens: 150,
      },
      {
        failureCount: 0,
        id: "00000000-0000-4000-8000-000000000479",
        label: "Usage Anthropic",
        requestCount: 1,
        totalCostUsd: "0.00100000",
        totalSavingsUsd: "0.00200000",
        totalTokens: 300,
      },
      {
        failureCount: 1,
        id: "unknown-provider",
        label: "Unknown provider",
        requestCount: 1,
        totalCostUsd: "0.00000000",
        totalSavingsUsd: "0.00000000",
        totalTokens: 0,
      },
    ]);
    expect(summary.modelBreakdowns.map(selectBreakdownFields)).toEqual([
      {
        failureCount: 0,
        id: "00000000-0000-4000-8000-000000000579",
        label: "GPT 4.1 Mini (gpt-4.1-mini)",
        requestCount: 1,
        totalCostUsd: "0.00050000",
        totalSavingsUsd: "0.00200000",
        totalTokens: 150,
      },
      {
        failureCount: 0,
        id: "00000000-0000-4000-8000-000000000679",
        label: "Claude Haiku (claude-haiku-4-5)",
        requestCount: 1,
        totalCostUsd: "0.00100000",
        totalSavingsUsd: "0.00200000",
        totalTokens: 300,
      },
      {
        failureCount: 1,
        id: "unknown-model",
        label: "Unknown model",
        requestCount: 1,
        totalCostUsd: "0.00000000",
        totalSavingsUsd: "0.00000000",
        totalTokens: 0,
      },
    ]);
    expect(formatConsoleUsageBreakdownStats(summary.agentBreakdowns[0])).toBe(
      "3 requests - 1 failure - 450 tokens - cost $0.00150000 - savings $0.00400000",
    );
    expect(formatConsoleUsageCost(summary.totalSavingsUsd)).toBe("$0.00400000");
  });
});

function selectBreakdownFields(input: {
  failureCount: number;
  id: string;
  label: string;
  requestCount: number;
  totalCostUsd: string | null;
  totalSavingsUsd: string | null;
  totalTokens: number;
}) {
  return {
    failureCount: input.failureCount,
    id: input.id,
    label: input.label,
    requestCount: input.requestCount,
    totalCostUsd: input.totalCostUsd,
    totalSavingsUsd: input.totalSavingsUsd,
    totalTokens: input.totalTokens,
  };
}

async function seedUsageBreakdownData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: "00000000-0000-4000-8000-000000000079",
    agentId: "00000000-0000-4000-8000-000000000079",
    anthropicModelId: "00000000-0000-4000-8000-000000000679",
    anthropicProviderId: "00000000-0000-4000-8000-000000000479",
    openaiModelId: "00000000-0000-4000-8000-000000000579",
    openaiProviderId: "00000000-0000-4000-8000-000000000379",
    virtualModelId: "00000000-0000-4000-8000-000000000279",
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Usage OpenAI', 'https://openai.example/v1', true),
             ($2, 'api_key', 'anthropic', 'Usage Anthropic', 'https://anthropic.example/v1', true)
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
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'usage-fast', 'Usage Fast', true)
    `,
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Codex Usage', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents
      set key_prefix = 'llmi_usage79',
          key_hash = 'hash-usage-079',
          default_virtual_model_id = $2
      where id = $1
    `,
    [ids.agentId, ids.virtualModelId],
  );

  await insertUsageBreakdownRequest(fixture, {
    ...ids,
    costUsd: "0.00050000",
    inputTokens: 50,
    outputTokens: 100,
    providerId: ids.openaiProviderId,
    providerModelId: ids.openaiModelId,
    requestId: "req_usage_breakdown_openai_079",
    savingsUsd: "0.00200000",
    status: "succeeded",
  });
  await insertUsageBreakdownRequest(fixture, {
    ...ids,
    costUsd: "0.00100000",
    inputTokens: 100,
    outputTokens: 200,
    providerId: ids.anthropicProviderId,
    providerModelId: ids.anthropicModelId,
    requestId: "req_usage_breakdown_anthropic_079",
    savingsUsd: "0.00200000",
    status: "succeeded",
  });
  await insertUsageBreakdownRequest(fixture, {
    ...ids,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    providerId: null,
    providerModelId: null,
    requestId: "req_usage_breakdown_failed_079",
    savingsUsd: null,
    status: "failed",
  });
}

async function insertUsageBreakdownRequest(
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
        completed_at
      )
      values (
        $1, $2, $3, $4, $5, $6, 'llmi_usage79', 'chat_completions', 'usage-fast',
        false, $7, case when $7 = 'failed' then 'provider_error' else null end,
        case when $7 = 'failed' then 502 else 200 end,
        '2026-06-16T11:00:00.000Z'::timestamptz,
        '2026-06-16T11:00:01.000Z'::timestamptz
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
          cost_source,
          actual_cost_usd,
          baseline_cost_usd,
          savings_usd
        )
        values ($1, $2, $3, $4, $5::numeric, 'estimated', $5::numeric, ($5::numeric + $6::numeric), $6::numeric)
      `,
      [
        randomUUID(),
        activityId,
        input.agentApiKeyId,
        input.providerModelId,
        input.costUsd,
        input.savingsUsd,
      ],
    );
  }
}
