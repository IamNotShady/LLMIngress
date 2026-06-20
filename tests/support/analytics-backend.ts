import { randomUUID } from "node:crypto";
import type { TestPostgresFixture } from "../../packages/db/src/index";

export const analyticsIds = {
  otherAgentApiKeyId: "00000000-0000-4000-8000-000000002105",
  otherAgentId: "00000000-0000-4000-8000-000000002105",
  otherProviderId: "00000000-0000-4000-8000-000000003105",
  otherProviderModelId: "00000000-0000-4000-8000-000000004105",
  otherRoutePolicyId: "00000000-0000-4000-8000-000000005105",
  otherVirtualModelId: "00000000-0000-4000-8000-000000006105",
  targetAgentApiKeyId: "00000000-0000-4000-8000-000000008105",
  targetAgentId: "00000000-0000-4000-8000-000000008105",
  targetFallbackProviderModelId: "00000000-0000-4000-8000-000000009105",
  targetProviderId: "00000000-0000-4000-8000-000000010105",
  targetProviderModelId: "00000000-0000-4000-8000-000000011105",
  targetRoutePolicyId: "00000000-0000-4000-8000-000000012105",
  targetVirtualModelId: "00000000-0000-4000-8000-000000013105",
} as const;

export async function seedAnalyticsBackendData(fixture: TestPostgresFixture): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'analytics-openai', 'Analytics OpenAI', 'https://openai.example/v1', true),
             ($2, 'api_key', 'analytics-other', 'Analytics Other', 'https://other.example/v1', true)
    `,
    [analyticsIds.targetProviderId, analyticsIds.otherProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-analytics-mini', 'GPT Analytics Mini', 'available'),
             ($3, $2, 'gpt-analytics-fallback', 'GPT Analytics Fallback', 'available'),
             ($4, $5, 'claude-analytics-other', 'Claude Analytics Other', 'available')
    `,
    [
      analyticsIds.targetProviderModelId,
      analyticsIds.targetProviderId,
      analyticsIds.targetFallbackProviderModelId,
      analyticsIds.otherProviderModelId,
      analyticsIds.otherProviderId,
    ],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'analytics-fast', 'Analytics Fast', true),
             ($2, 'analytics-other', 'Analytics Other', true)
    `,
    [analyticsIds.targetVirtualModelId, analyticsIds.otherVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'balanced'),
             ($3, $4, 'fixed')
    `,
    [
      analyticsIds.targetRoutePolicyId,
      analyticsIds.targetVirtualModelId,
      analyticsIds.otherRoutePolicyId,
      analyticsIds.otherVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, enabled)
      values ($1, 'Analytics Target Agent', 'coding', true),
             ($2, 'Analytics Other Agent', 'coding', true)
    `,
    [analyticsIds.targetAgentId, analyticsIds.otherAgentId],
  );
  await fixture.query(
    `
      update agents
      set key_prefix = case
            when id = $1 then 'llmi_analytics105'
            else 'llmi_other105'
          end,
          key_hash = case
            when id = $1 then 'hash-analytics-105'
            else 'hash-other-105'
          end,
          default_virtual_model_id = case
            when id = $1 then $3::uuid
            else $4::uuid
          end
      where id in ($1, $2)
    `,
    [
      analyticsIds.targetAgentId,
      analyticsIds.otherAgentId,
      analyticsIds.targetVirtualModelId,
      analyticsIds.otherVirtualModelId,
    ],
  );

  await insertAnalyticsRequest(fixture, {
    activityId: "10000000-0000-4000-8000-000000000105",
    costUsd: "0.00100000",
    inputTokens: 40,
    latencyMs: 100,
    outputTokens: 60,
    requestId: "req_analytics_current_fast_105",
    savingsUsd: "0.00400000",
    startedAt: "2026-06-18T10:15:00.000Z",
    status: "succeeded",
  });
  await insertAnalyticsRequest(fixture, {
    activityId: "10000000-0000-4000-8000-000000001105",
    costUsd: "0.00200000",
    inputTokens: 80,
    latencyMs: 200,
    outputTokens: 120,
    requestId: "req_analytics_current_fallback_105",
    savingsUsd: "0.00300000",
    startedAt: "2026-06-18T11:30:00.000Z",
    status: "succeeded",
  });
  await insertFallbackEvent(fixture, {
    activityId: "10000000-0000-4000-8000-000000001105",
    attemptOrder: 1,
    providerModelId: analyticsIds.targetProviderModelId,
    status: "failed",
  });
  await insertFallbackEvent(fixture, {
    activityId: "10000000-0000-4000-8000-000000001105",
    attemptOrder: 2,
    providerModelId: analyticsIds.targetFallbackProviderModelId,
    status: "succeeded",
  });
  await insertAnalyticsRequest(fixture, {
    activityId: "10000000-0000-4000-8000-000000002105",
    costUsd: null,
    inputTokens: 0,
    latencyMs: 700,
    outputTokens: 0,
    requestId: "req_analytics_current_failed_105",
    savingsUsd: null,
    startedAt: "2026-06-18T12:45:00.000Z",
    status: "failed",
  });
  await insertAnalyticsRequest(fixture, {
    activityId: "10000000-0000-4000-8000-000000003105",
    costUsd: "0.00070000",
    inputTokens: 20,
    latencyMs: 50,
    outputTokens: 30,
    requestId: "req_analytics_previous_105",
    savingsUsd: "0.00100000",
    startedAt: "2026-06-18T07:00:00.000Z",
    status: "succeeded",
  });
  await insertAnalyticsRequest(fixture, {
    activityId: "10000000-0000-4000-8000-000000004105",
    costUsd: "0.00990000",
    inputTokens: 990,
    latencyMs: 10,
    outputTokens: 990,
    requestId: "req_analytics_outside_105",
    savingsUsd: "0.00990000",
    startedAt: "2026-06-18T05:00:00.000Z",
    status: "succeeded",
  });
  await insertAnalyticsRequest(fixture, {
    activityId: "10000000-0000-4000-8000-000000005105",
    agentApiKeyId: analyticsIds.otherAgentApiKeyId,
    costUsd: "0.00500000",
    inputTokens: 500,
    latencyMs: 300,
    outputTokens: 500,
    providerId: analyticsIds.otherProviderId,
    providerModelId: analyticsIds.otherProviderModelId,
    requestId: "req_analytics_other_filtered_105",
    routePolicyId: analyticsIds.otherRoutePolicyId,
    savingsUsd: "0.00200000",
    startedAt: "2026-06-18T11:00:00.000Z",
    status: "succeeded",
    virtualModelId: analyticsIds.otherVirtualModelId,
  });
}

async function insertAnalyticsRequest(
  fixture: TestPostgresFixture,
  input: {
    activityId: string;
    agentApiKeyId?: string;
    costUsd: string | null;
    inputTokens: number;
    latencyMs: number;
    outputTokens: number;
    providerId?: string;
    providerModelId?: string;
    requestId: string;
    routePolicyId?: string;
    savingsUsd: string | null;
    startedAt: string;
    status: "failed" | "succeeded";
    virtualModelId?: string;
  },
): Promise<void> {
  const agentApiKeyId = input.agentApiKeyId ?? analyticsIds.targetAgentApiKeyId;
  const providerId = input.providerId ?? analyticsIds.targetProviderId;
  const providerModelId = input.providerModelId ?? analyticsIds.targetProviderModelId;
  const routePolicyId = input.routePolicyId ?? analyticsIds.targetRoutePolicyId;
  const virtualModelId = input.virtualModelId ?? analyticsIds.targetVirtualModelId;
  const totalTokens = input.inputTokens + input.outputTokens;

  await fixture.query(
    `
      insert into request_activity (
        id, request_id, agent_id, virtual_model_id, route_policy_id, provider_id,
        provider_model_id, agent_key_prefix, protocol, model, stream, status, error_code,
        http_status, latency_ms, started_at, completed_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, 'llmi_analytics105', 'chat_completions',
        'analytics-fast', false, $8, case when $8 = 'failed' then 'provider_error' else null end,
        case when $8 = 'failed' then 502 else 200 end, $9, $10::timestamptz,
        $10::timestamptz + interval '1 second'
      )
    `,
    [
      input.activityId,
      input.requestId,
      agentApiKeyId,
      virtualModelId,
      routePolicyId,
      providerId,
      providerModelId,
      input.status,
      input.latencyMs,
      input.startedAt,
    ],
  );

  if (totalTokens > 0) {
    await fixture.query(
      `
        insert into request_usage (
          id, request_activity_id, agent_id, virtual_model_id, provider_model_id,
          input_tokens, output_tokens, total_tokens, token_source
        )
        values ($8, $1, $2, $3, $4, $5, $6, $7, 'estimated')
      `,
      [
        input.activityId,
        agentApiKeyId,
        virtualModelId,
        providerModelId,
        input.inputTokens,
        input.outputTokens,
        totalTokens,
        randomUUID(),
      ],
    );
  }
  if (input.costUsd !== null) {
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
        values (
          $5,
          $1,
          $2,
          $3,
          $4::numeric,
          'estimated',
          $4::numeric,
          case when $6::text is null then null else ($4::numeric + $6::numeric) end,
          $6::numeric
        )
      `,
      [
        input.activityId,
        agentApiKeyId,
        providerModelId,
        input.costUsd,
        randomUUID(),
        input.savingsUsd,
      ],
    );
  }
}

async function insertFallbackEvent(
  fixture: TestPostgresFixture,
  input: {
    activityId: string;
    attemptOrder: number;
    providerModelId: string;
    status: "failed" | "succeeded";
  },
): Promise<void> {
  await fixture.query(
    `
      insert into fallback_events (
        id, request_activity_id, provider_model_id, attempt_order, status, error_code,
        failed_before_first_byte
      )
      values (
        $5, $1, $2, $3, $4,
        case when $4 = 'failed' then 'provider_error' else null end,
        $4 = 'failed'
      )
    `,
    [input.activityId, input.providerModelId, input.attemptOrder, input.status, randomUUID()],
  );
}
