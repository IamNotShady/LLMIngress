import { randomUUID } from "node:crypto";
import type { ManualPriceOverride } from "@llmingress/billing/price-registry";
import { resolveEffectiveModelTokenPrice } from "@llmingress/billing/price-registry";
import { createConfigPublisher } from "@llmingress/config/config-publisher";
import { Client, type QueryResultRow } from "pg";

export type AgentLimitType = "budget" | "rpm" | "token" | "tpm";
export type AgentLimitPeriod = "day" | "hour" | "minute" | "month" | "request" | "week";
export type AgentLimitUnit = "requests" | "tokens" | "usd";

export type AgentLimitRuleInput = {
  limitType: AgentLimitType;
  limitValue: number;
  period: AgentLimitPeriod;
  unit: AgentLimitUnit;
};

export type AgentLimitFormInput = {
  agentApiKeyId?: string | null;
  budgetPeriod?: string | null;
  budgetPriceModelId?: string | null;
  budgetPriceProviderKey?: string | null;
  budgetUsd?: string | number | null;
  rpm?: string | number | null;
  tokenLimit?: string | number | null;
  tpm?: string | number | null;
};

export type NormalizedAgentLimitFormInput = {
  agentApiKeyId: string;
  budgetPriceCheck: {
    modelId: string;
    providerKey: string;
  };
  rules: AgentLimitRuleInput[];
};

export type ConsoleAgentLimit = AgentLimitRuleInput & {
  agentApiKeyId: string;
  enabled: boolean;
  id: string;
};

type AgentLimitRow = QueryResultRow & {
  agent_api_key_id: string;
  enabled: boolean;
  id: string;
  limit_type: AgentLimitType;
  limit_value: string;
  period: AgentLimitPeriod;
  unit: AgentLimitUnit;
};

type PriceOverrideRow = QueryResultRow & {
  input_usd_per_million_tokens: string;
  model_id: string;
  output_usd_per_million_tokens: string;
  provider_key: string;
  updated_at: Date;
};

type QueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

const budgetPeriods = ["day", "week", "month"] as const;

export function normalizeAgentLimitFormInput(
  input: AgentLimitFormInput,
): NormalizedAgentLimitFormInput {
  const agentApiKeyId = normalizeRequiredText(input.agentApiKeyId, "Agent API key id");
  const budgetPeriod = normalizeBudgetPeriod(input.budgetPeriod);
  const providerKey = normalizeRequiredText(
    input.budgetPriceProviderKey,
    "Budget price provider key",
  ).toLowerCase();
  const modelId = normalizeRequiredText(input.budgetPriceModelId, "Budget price model id");

  return {
    agentApiKeyId,
    budgetPriceCheck: {
      modelId,
      providerKey,
    },
    rules: [
      {
        limitType: "budget",
        limitValue: normalizePositiveNumber(input.budgetUsd, "Budget USD limit"),
        period: budgetPeriod,
        unit: "usd",
      },
      {
        limitType: "rpm",
        limitValue: normalizePositiveNumber(input.rpm, "RPM limit"),
        period: "minute",
        unit: "requests",
      },
      {
        limitType: "tpm",
        limitValue: normalizePositiveNumber(input.tpm, "TPM limit"),
        period: "minute",
        unit: "tokens",
      },
      {
        limitType: "token",
        limitValue: normalizePositiveNumber(input.tokenLimit, "Token limit"),
        period: "request",
        unit: "tokens",
      },
    ],
  };
}

export function getCostBudgetPriceValidationError(input: {
  manualOverride: ManualPriceOverride | null;
  modelId: string;
  providerKey: string;
}): string | null {
  const price = resolveEffectiveModelTokenPrice(input);
  if (price.status === "unknown_price") {
    return `Cannot enable cost budget for ${input.providerKey}/${input.modelId} because the model has unknown price. Save a manual price override first.`;
  }
  return null;
}

export function formatAgentLimitSummaries(
  limits: readonly ConsoleAgentLimit[],
): Record<AgentLimitType, string> {
  return {
    budget: formatLimitSummary(limits.find((limit) => limit.limitType === "budget")),
    rpm: formatLimitSummary(limits.find((limit) => limit.limitType === "rpm")),
    token: formatLimitSummary(limits.find((limit) => limit.limitType === "token")),
    tpm: formatLimitSummary(limits.find((limit) => limit.limitType === "tpm")),
  };
}

export async function listAgentLimits(databaseUrl: string): Promise<ConsoleAgentLimit[]> {
  return withClient(databaseUrl, (client) => readAgentLimits(client));
}

export async function saveAgentLimitRules(input: {
  databaseUrl: string;
  limits: NormalizedAgentLimitFormInput;
}): Promise<ConsoleAgentLimit[]> {
  let savedLimits: ConsoleAgentLimit[] | undefined;

  const publisher = createConfigPublisher({ databaseUrl: input.databaseUrl });
  await publisher.publish({
    source: "console",
    description: `Update Agent API key limits ${input.limits.agentApiKeyId}`,
    changes: [{ table: "agent_limits", recordId: input.limits.agentApiKeyId }],
    write: async (client) => {
      await assertAgentApiKeyExists(client, input.limits.agentApiKeyId);
      await assertCostBudgetPriceKnown(client, input.limits.budgetPriceCheck);

      await client.query(
        `
          delete from agent_limits
          where agent_api_key_id = $1
            and limit_type = any($2::text[])
        `,
        [input.limits.agentApiKeyId, input.limits.rules.map((rule) => rule.limitType)],
      );

      for (const rule of input.limits.rules) {
        await client.query(
          `
            insert into agent_limits (
              id,
              agent_api_key_id,
              limit_type,
              period,
              limit_value,
              unit,
              enabled
            )
            values ($1, $2, $3, $4, $5, $6, true)
          `,
          [
            randomUUID(),
            input.limits.agentApiKeyId,
            rule.limitType,
            rule.period,
            rule.limitValue,
            rule.unit,
          ],
        );
      }

      savedLimits = await readAgentLimits(client, input.limits.agentApiKeyId);
    },
  });

  if (!savedLimits) {
    throw new Error("Agent API key limits were not saved.");
  }
  return savedLimits;
}

async function assertAgentApiKeyExists(client: QueryClient, id: string): Promise<void> {
  const result = await client.query("select 1 from agent_api_keys where id = $1 for update", [id]);
  if (!result.rows[0]) {
    throw new Error("Agent API key was not found.");
  }
}

async function assertCostBudgetPriceKnown(
  client: QueryClient,
  input: { modelId: string; providerKey: string },
): Promise<void> {
  const validationError = getCostBudgetPriceValidationError({
    manualOverride: await readManualPriceOverride(client, input),
    modelId: input.modelId,
    providerKey: input.providerKey,
  });
  if (validationError) {
    throw new Error(validationError);
  }
}

async function readManualPriceOverride(
  client: QueryClient,
  input: { modelId: string; providerKey: string },
): Promise<ManualPriceOverride | null> {
  const result = await client.query<PriceOverrideRow>(
    `
      select provider_key,
             model_id,
             input_usd_per_million_tokens::text,
             output_usd_per_million_tokens::text,
             updated_at
      from model_price_overrides
      where provider_key = $1
        and model_id = $2
    `,
    [input.providerKey, input.modelId],
  );
  const row = result.rows[0];
  return row
    ? {
        inputUsdPerMillionTokens: Number(row.input_usd_per_million_tokens),
        modelId: row.model_id,
        outputUsdPerMillionTokens: Number(row.output_usd_per_million_tokens),
        providerKey: row.provider_key,
        updatedAt: row.updated_at,
      }
    : null;
}

async function readAgentLimits(
  client: QueryClient,
  agentApiKeyId?: string,
): Promise<ConsoleAgentLimit[]> {
  const result = await client.query<AgentLimitRow>(
    `
      select id::text,
             agent_api_key_id::text,
             limit_type,
             period,
             limit_value::text,
             unit,
             enabled
      from agent_limits
      where ($1::uuid is null or agent_api_key_id = $1::uuid)
      order by agent_api_key_id, limit_type
    `,
    [agentApiKeyId ?? null],
  );
  return result.rows.map((row) => ({
    agentApiKeyId: row.agent_api_key_id,
    enabled: row.enabled,
    id: row.id,
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    period: row.period,
    unit: row.unit,
  }));
}

function formatLimitSummary(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  if (limit.unit === "usd") {
    return `$${limit.limitValue.toFixed(2)} / ${limit.period}`;
  }
  return `${formatNumber(limit.limitValue)} ${limit.unit} / ${limit.period}`;
}

function normalizeBudgetPeriod(value: string | null | undefined): (typeof budgetPeriods)[number] {
  const period = normalizeRequiredText(value, "Budget period");
  if (!budgetPeriods.includes(period as (typeof budgetPeriods)[number])) {
    throw new Error("Budget period must be day, week, or month.");
  }
  return period as (typeof budgetPeriods)[number];
}

function normalizePositiveNumber(value: string | number | null | undefined, label: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return numberValue;
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

async function withClient<T>(
  databaseUrl: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
