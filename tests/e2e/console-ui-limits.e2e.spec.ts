import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

const LIMITS_AGENT_ID = "00000000-0000-4000-8000-000000000831";
const LIMITS_PROVIDER_ID = "00000000-0000-4000-8000-000000000832";
const LIMITS_PROVIDER_MODEL_ID = "00000000-0000-4000-8000-000000000833";
const LIMITS_VIRTUAL_MODEL_ID = "00000000-0000-4000-8000-000000000834";
const LIMITS_SECONDARY_VIRTUAL_MODEL_ID = "00000000-0000-4000-8000-000000000835";
const LIMITS_SECONDARY_AGENT_ID = "00000000-0000-4000-8000-000000000836";

test("limits page renders the reference KPI, table, and rule configuration layout", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl, databaseUrl }) => {
      await page.goto(`${baseUrl}/limits?selected=${LIMITS_AGENT_ID}`);

      await expect(page.getByRole("heading", { level: 1, name: "Limits" })).toBeVisible();
      await expect(
        page.getByText("管理 Agent API Key 的预算、Token、RPM、TPM 与并发限制"),
      ).toBeVisible();

      for (const label of ["已配置规则", "今日超限次数", "接近预算 Key", "Rate Limit 触发"]) {
        await expect(page.locator(".stat-card-label", { hasText: label })).toBeVisible();
      }

      await expect(page.getByPlaceholder("搜索 Agent 或 API Key Prefix")).toBeVisible();
      await expect(page.getByRole("link", { name: "新增规则" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Limit Rules" })).toBeVisible();

      const table = page.getByRole("table");
      for (const column of [
        "Agent",
        "API Key",
        "成本上限",
        "Token 上限",
        "RPM",
        "TPM",
        "并发",
        "使用率",
        "状态",
        "操作",
      ]) {
        await expect(table.getByRole("columnheader", { name: column, exact: true })).toBeVisible();
      }

      await expect(table.getByRole("cell", { exact: true, name: "Cursor" })).toBeVisible();
      await expect(table.getByRole("cell", { exact: true, name: "84%" })).toBeVisible();
      await expect(table.getByText("警告", { exact: true })).toBeVisible();
      await expect(table.getByRole("link", { name: "编辑" })).toHaveCount(0);
      await expect(table.getByRole("button", { name: "删除 Cursor" })).toBeVisible();
      await expect(table.getByRole("button", { name: "删除 Hermes" })).toBeVisible();
      await expect(
        page.getByText("当前版本：超限后统一直接阻断请求，不支持人工绕过。", { exact: true }),
      ).toHaveCount(0);

      await expect(page.getByRole("heading", { name: "规则配置" })).toBeVisible();
      for (const removedOption of ["Budget", "Rate Limit", "Allowed Models"]) {
        await expect(page.getByText(removedOption, { exact: true })).toHaveCount(0);
      }
      for (const label of [
        "成本上限 (USD)",
        "Token 上限",
        "周期",
        "告警阈值",
        "RPM",
        "TPM",
        "并发数",
      ]) {
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
      }
      await expect(page.locator(".limits-field-hint")).toHaveCount(0);
      await expect(page.getByText("当前使用率")).toBeVisible();
      await expect(page.getByText("coding-balanced", { exact: true })).toBeVisible();
      await expect(page.getByText("smart", { exact: true })).toBeVisible();
      await expect(page.getByText("当前版本说明", { exact: true })).toHaveCount(0);
      await expect(
        page.getByText("不支持 per-rule 阻断策略或人工绕过；超限直接阻断。", { exact: true }),
      ).toHaveCount(0);

      await table
        .getByRole("row", { name: /Hermes/ })
        .getByRole("link", { name: "Hermes" })
        .click();
      await expect(page).toHaveURL(new RegExp(`/limits\\?selected=${LIMITS_SECONDARY_AGENT_ID}$`));
      const configPanel = page.getByLabel("规则配置");
      await expect(configPanel.getByText("Hermes", { exact: true })).toBeVisible();
      await expect(configPanel.getByLabel("成本上限 (USD)", { exact: true })).toHaveValue("25");
      await expect(configPanel.getByLabel("并发数", { exact: true })).toHaveValue("3");

      await table.getByRole("button", { name: "删除 Hermes" }).click();
      await expect(page).toHaveURL(/\/limits$/);
      await expect(table.getByRole("cell", { name: "Hermes" })).toHaveCount(0);
      await expect.poll(() => readAgentLimitCount(databaseUrl, LIMITS_SECONDARY_AGENT_ID)).toBe(0);
    },
    { seed: seedReferenceLimits },
  );
});

test("limits save persists budget rate concurrency threshold rules and stays on Limits", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl, databaseUrl }) => {
      await page.goto(`${baseUrl}/limits?selected=${LIMITS_AGENT_ID}`);

      await page.getByLabel("成本上限 (USD)", { exact: true }).fill("120");
      await page.getByLabel("Token 上限", { exact: true }).fill("2500000");
      await page.getByLabel("周期", { exact: true }).selectOption("month");
      await page.getByLabel("告警阈值", { exact: true }).fill("75");
      await page.getByLabel("RPM", { exact: true }).fill("150");
      await page.getByLabel("TPM", { exact: true }).fill("80000");
      await page.getByLabel("并发数", { exact: true }).fill("12");
      await page.getByRole("button", { name: "保存规则" }).click();

      await expect(page).toHaveURL(new RegExp(`/limits\\?selected=${LIMITS_AGENT_ID}$`));
      await expect(page.getByRole("heading", { level: 1, name: "Limits" })).toBeVisible();
      await expect
        .poll(() => readAgentLimits(databaseUrl))
        .toEqual([
          {
            alertThreshold: "0.750000",
            limitType: "budget",
            limitValue: "120.000000",
            period: "month",
            unit: "usd",
          },
          {
            alertThreshold: "0.750000",
            limitType: "concurrency",
            limitValue: "12.000000",
            period: "request",
            unit: "requests",
          },
          {
            alertThreshold: "0.750000",
            limitType: "rpm",
            limitValue: "150.000000",
            period: "minute",
            unit: "requests",
          },
          {
            alertThreshold: "0.750000",
            limitType: "token",
            limitValue: "2500000.000000",
            period: "request",
            unit: "tokens",
          },
          {
            alertThreshold: "0.750000",
            limitType: "tpm",
            limitValue: "80000.000000",
            period: "minute",
            unit: "tokens",
          },
        ]);
    },
    { seed: seedReferenceLimits },
  );
});

type AgentLimitRow = {
  alert_threshold: string | null;
  limit_type: string;
  limit_value: string;
  period: string;
  unit: string;
};

async function readAgentLimits(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<AgentLimitRow>(
      `
        select alert_threshold::text,
               limit_type,
               limit_value::text,
               period,
               unit
        from agent_limits
        where agent_id = $1
        order by limit_type
      `,
      [LIMITS_AGENT_ID],
    );
    return result.rows.map((row) => ({
      alertThreshold: row.alert_threshold,
      limitType: row.limit_type,
      limitValue: row.limit_value,
      period: row.period,
      unit: row.unit,
    }));
  } finally {
    await client.end();
  }
}

async function readAgentLimitCount(databaseUrl: string, agentId: string): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ limit_count: string }>(
      "select count(*) as limit_count from agent_limits where agent_id = $1",
      [agentId],
    );
    return Number(result.rows[0]?.limit_count ?? 0);
  } finally {
    await client.end();
  }
}

async function seedReferenceLimits(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'OpenAI', 'https://openai.example/v1', true)
      `,
      [LIMITS_PROVIDER_ID],
    );
    await client.query(
      `
        insert into provider_models (
          id,
          provider_id,
          model_id,
          display_name,
          availability,
          manual_input_usd_per_million_tokens,
          manual_output_usd_per_million_tokens,
          manual_price_updated_at
        )
        values ($1, $2, 'gpt-4.1-nano', 'GPT 4.1 Nano', 'available', 1.25, 5.50, now())
      `,
      [LIMITS_PROVIDER_MODEL_ID, LIMITS_PROVIDER_ID],
    );
    await client.query(
      `
        insert into virtual_models (id, name, description, enabled)
        values ($1, 'coding-balanced', 'Coding Balanced', true),
               ($2, 'smart', 'Smart', true)
      `,
      [LIMITS_VIRTUAL_MODEL_ID, LIMITS_SECONDARY_VIRTUAL_MODEL_ID],
    );
    await seedRoutePolicy(client, LIMITS_VIRTUAL_MODEL_ID);
    await seedRoutePolicy(client, LIMITS_SECONDARY_VIRTUAL_MODEL_ID);
    await client.query(
      `
        insert into agents (
          id,
          name,
          agent_type,
          integration_platform,
          key_prefix,
          key_hash,
          default_virtual_model_id,
          enabled
        )
        values (
          $1,
          'Cursor',
          'coding',
          'cursor',
          'llmi_3ef',
          'hash-limits-cursor',
          $2,
          true
        )
      `,
      [LIMITS_AGENT_ID, LIMITS_VIRTUAL_MODEL_ID],
    );
    await client.query(
      `
        insert into agents (
          id,
          name,
          agent_type,
          integration_platform,
          key_prefix,
          key_hash,
          default_virtual_model_id,
          enabled
        )
        values (
          $1,
          'Hermes',
          'terminal',
          'hermes',
          'llmi_hms',
          'hash-limits-hermes',
          $2,
          true
        )
      `,
      [LIMITS_SECONDARY_AGENT_ID, LIMITS_SECONDARY_VIRTUAL_MODEL_ID],
    );
    await client.query(
      "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
      [LIMITS_AGENT_ID, LIMITS_SECONDARY_VIRTUAL_MODEL_ID],
    );
    await client.query(
      "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
      [LIMITS_SECONDARY_AGENT_ID, LIMITS_SECONDARY_VIRTUAL_MODEL_ID],
    );
    await client.query(
      `
        insert into agent_limits (
          id,
          agent_id,
          limit_type,
          period,
          limit_value,
          unit,
          enabled,
          alert_threshold,
          enforcement_policy,
          manual_bypass
        )
        values
          ($1, $6, 'budget', 'month', 100, 'usd', true, 0.8, 'block', false),
          ($2, $6, 'token', 'request', 2000000, 'tokens', true, 0.8, 'block', false),
          ($3, $6, 'rpm', 'minute', 120, 'requests', true, 0.8, 'block', false),
          ($4, $6, 'tpm', 'minute', 60000, 'tokens', true, 0.8, 'block', false),
          ($5, $6, 'concurrency', 'request', 10, 'requests', true, 0.8, 'block', false)
      `,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), LIMITS_AGENT_ID],
    );
    await client.query(
      `
        insert into agent_limits (
          id,
          agent_id,
          limit_type,
          period,
          limit_value,
          unit,
          enabled,
          alert_threshold,
          enforcement_policy,
          manual_bypass
        )
        values
          ($1, $6, 'budget', 'month', 25, 'usd', true, 0.9, 'block', false),
          ($2, $6, 'token', 'request', 400000, 'tokens', true, 0.9, 'block', false),
          ($3, $6, 'rpm', 'minute', 30, 'requests', true, 0.9, 'block', false),
          ($4, $6, 'tpm', 'minute', 50000, 'tokens', true, 0.9, 'block', false),
          ($5, $6, 'concurrency', 'request', 3, 'requests', true, 0.9, 'block', false)
      `,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        LIMITS_SECONDARY_AGENT_ID,
      ],
    );
    await client.query(
      `
        insert into budget_periods (
          id,
          agent_id,
          period_type,
          period_start,
          period_end,
          cost_used_usd,
          reserved_cost_usd,
          tokens_used,
          reserved_tokens
        )
        values (
          $1,
          $2,
          'month',
          date_trunc('month', now()),
          date_trunc('month', now()) + interval '1 month',
          65,
          19,
          800000,
          100000
        )
      `,
      [randomUUID(), LIMITS_AGENT_ID],
    );
    await client.query(
      `
        insert into rate_limit_windows (
          id,
          agent_id,
          limit_type,
          window_start,
          window_end,
          request_count,
          token_count,
          active_count
        )
        values
          ($1, $4, 'rpm', date_trunc('minute', now()), date_trunc('minute', now()) + interval '1 minute', 15, 0, 0),
          ($2, $4, 'tpm', date_trunc('minute', now()), date_trunc('minute', now()) + interval '1 minute', 0, 3000, 0),
          ($3, $4, 'concurrency', timestamp '1970-01-01 00:00:00+00', timestamp '9999-12-31 23:59:59.999+00', 0, 0, 2)
      `,
      [randomUUID(), randomUUID(), randomUUID(), LIMITS_AGENT_ID],
    );
    await seedLimitError(client, "req_limits_rate_1", "rate_limit_exceeded");
    await seedLimitError(client, "req_limits_rate_2", "rate_limit_exceeded");
    await seedLimitError(client, "req_limits_cost", "cost_budget_exceeded");
  } finally {
    await client.end();
  }
}

async function seedRoutePolicy(client: Client, virtualModelId: string): Promise<void> {
  const routePolicyId = randomUUID();
  await client.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
  );
  await client.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order,
        is_fallback
      )
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), routePolicyId, LIMITS_PROVIDER_MODEL_ID],
  );
}

async function seedLimitError(client: Client, requestId: string, errorCode: string): Promise<void> {
  await client.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        agent_key_prefix,
        protocol,
        model,
        status,
        error_code,
        http_status,
        started_at,
        completed_at
      )
      values (
        $1,
        $2,
        $3,
        'llmi_3ef',
        'chat_completions',
        'coding-balanced',
        'failed',
        $4,
        429,
        now() - interval '30 minutes',
        now() - interval '29 minutes'
      )
    `,
    [randomUUID(), requestId, LIMITS_AGENT_ID, errorCode],
  );
}
