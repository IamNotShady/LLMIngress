import { getPostgresPool, type PostgresQueryResultRow } from "@llmingress/db/client";

export type GatewayAgentLimitType = "budget" | "concurrency" | "rpm" | "token" | "tpm";
export type GatewayAgentLimitEnforcementPolicy = "block" | "warn_only";

export type GatewayEnabledAgentLimit = {
  enforcementPolicy: GatewayAgentLimitEnforcementPolicy;
  limitType: GatewayAgentLimitType;
  limitValue: number;
  manualBypass: boolean;
  period: string;
  unit: string;
};

type AgentLimitRow = PostgresQueryResultRow & {
  enforcement_policy: GatewayAgentLimitEnforcementPolicy;
  limit_type: GatewayAgentLimitType;
  limit_value: string;
  manual_bypass: boolean;
  period: string;
  unit: string;
};

export async function readEnabledGatewayAgentLimits(input: {
  agentId: string;
  databaseUrl?: string;
}): Promise<GatewayEnabledAgentLimit[]> {
  const result = await getPostgresPool(input.databaseUrl).query<AgentLimitRow>(
    `
      select limit_type,
             period,
             limit_value::text,
             unit,
             enforcement_policy,
             manual_bypass
      from agent_limits
      where agent_id = $1
        and enabled = true
        and limit_type in ('budget', 'concurrency', 'rpm', 'token', 'tpm')
    `,
    [input.agentId],
  );

  return result.rows.map((row) => ({
    enforcementPolicy: row.enforcement_policy,
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    manualBypass: row.manual_bypass,
    period: row.period,
    unit: row.unit,
  }));
}
