import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const expectedActualCostUsd = 0.11;
const expectedActualTokens = 1200;

test("gateway records non-streaming budget usage without reservations", async () => {
  await withSettlementGateway(
    { budgetLimitUsd: 1, mode: "cached-usage", virtualModelName: "vm-settlement-json" },
    async ({ agentApiKey, baseUrl, fakeProvider, fixture, seeded }) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-settlement-json",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(fakeProvider.requests).toHaveLength(1);
      await expect
        .poll(() => readBudgetUsage(fixture, seeded.agentId))
        .toEqual({
          costUsedUsd: expectedActualCostUsd,
          tokensUsed: expectedActualTokens,
        });
      await expect.poll(() => budgetReservationsTableExists(fixture)).toBe(false);
    },
  );
});

test("gateway records streaming budget usage after EOF without reservations", async () => {
  await withSettlementGateway(
    {
      budgetLimitUsd: 1,
      mode: "stream&usage=chat&stream_end_ms=100",
      virtualModelName: "vm-settlement-stream",
    },
    async ({ agentApiKey, baseUrl, fakeProvider, fixture, seeded }) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-settlement-stream",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[DONE]");
      expect(fakeProvider.requests).toHaveLength(1);
      await expect
        .poll(() => readBudgetUsage(fixture, seeded.agentId))
        .toEqual({
          costUsedUsd: expectedActualCostUsd,
          tokensUsed: expectedActualTokens,
        });
      await expect.poll(() => budgetReservationsTableExists(fixture)).toBe(false);
    },
  );
});

test("gateway records unknown-price JSON usage with zero cost", async () => {
  await withSettlementGateway(
    {
      budgetLimitUsd: 1,
      mode: "cached-usage",
      priceKnown: false,
      virtualModelName: "vm-settlement-unknown-json",
    },
    async ({ agentApiKey, baseUrl, fakeProvider, fixture, seeded }) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-settlement-unknown-json",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(fakeProvider.requests).toHaveLength(1);
      await expect
        .poll(() => readBudgetUsage(fixture, seeded.agentId))
        .toEqual({
          costUsedUsd: 0,
          tokensUsed: expectedActualTokens,
        });
      await expect
        .poll(() => readLatestRequestCost(fixture))
        .toEqual({
          costSource: "unavailable",
          inputCostUsd: 0,
          outputCostUsd: 0,
          priceSource: "unavailable",
          totalCostUsd: 0,
        });
    },
  );
});

test("gateway records unknown-price streaming usage with zero cost", async () => {
  await withSettlementGateway(
    {
      budgetLimitUsd: 1,
      mode: "stream&usage=chat&stream_end_ms=100",
      priceKnown: false,
      virtualModelName: "vm-settlement-unknown-stream",
    },
    async ({ agentApiKey, baseUrl, fakeProvider, fixture, seeded }) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-settlement-unknown-stream",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[DONE]");
      expect(fakeProvider.requests).toHaveLength(1);
      await expect
        .poll(() => readBudgetUsage(fixture, seeded.agentId))
        .toEqual({
          costUsedUsd: 0,
          tokensUsed: expectedActualTokens,
        });
      await expect
        .poll(() => readLatestRequestCost(fixture))
        .toEqual({
          costSource: "unavailable",
          inputCostUsd: 0,
          outputCostUsd: 0,
          priceSource: "unavailable",
          totalCostUsd: 0,
        });
    },
  );
});

test("gateway rejects exceeded budgets before provider calls", async () => {
  await withSettlementGateway(
    { budgetLimitUsd: 0.000001, mode: "cached-usage", virtualModelName: "vm-budget-exceeded" },
    async ({ agentApiKey, baseUrl, fakeProvider, fixture, seeded }) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-budget-exceeded",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(402);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "cost_budget_exceeded" },
      });
      expect(fakeProvider.requests).toHaveLength(0);
      await expect.poll(() => readBudgetUsage(fixture, seeded.agentId)).toBeNull();
      await expect.poll(() => budgetReservationsTableExists(fixture)).toBe(false);
    },
  );
});

type SettlementGatewayContext = {
  agentApiKey: string;
  baseUrl: string;
  fakeProvider: Awaited<ReturnType<typeof createFakeProviderServer>>;
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  seeded: Awaited<ReturnType<typeof seedOpenAIGatewayRoute>>;
};

async function withSettlementGateway(
  input: {
    budgetLimitUsd: number;
    mode: string;
    priceKnown?: boolean;
    virtualModelName: string;
  },
  run: (context: SettlementGatewayContext) => Promise<void>,
): Promise<void> {
  const agentApiKey = `llmi_gateway_settlement_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_settlement_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=${input.mode}`,
      virtualModelName: input.virtualModelName,
    });
    if (input.priceKnown !== false) {
      await fixture.query(
        `
          update provider_models
          set manual_input_usd_per_million_tokens = 100,
              manual_output_usd_per_million_tokens = 50,
              manual_price_updated_at = now()
          where id = $1
        `,
        [seeded.providerModelId],
      );
    }
    await fixture.query(
      `
        insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
        values ($1, $2, 'budget', 'day', $3, 'usd', true)
      `,
      [randomUUID(), seeded.agentId, input.budgetLimitUsd],
    );

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);
      await run({ agentApiKey, baseUrl, fakeProvider, fixture, seeded });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
}

type QueryableFixture = {
  query: <T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

async function readBudgetUsage(
  fixture: QueryableFixture,
  agentId: string,
): Promise<{ costUsedUsd: number; tokensUsed: number } | null> {
  const result = await fixture.query<{
    cost_used_usd: string;
    tokens_used: string;
  }>(
    `
      select tokens_used::text,
             cost_used_usd::text
      from budget_periods
      where agent_id = $1
      order by created_at desc
      limit 1
    `,
    [agentId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    costUsedUsd: Number(row.cost_used_usd),
    tokensUsed: Number(row.tokens_used),
  };
}

async function budgetReservationsTableExists(fixture: QueryableFixture): Promise<boolean> {
  const result = await fixture.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'budget_reservations'
      ) as exists
    `,
  );
  return result.rows[0]?.exists ?? false;
}

async function readLatestRequestCost(fixture: QueryableFixture): Promise<{
  costSource: string;
  inputCostUsd: number;
  outputCostUsd: number;
  priceSource: string;
  totalCostUsd: number;
} | null> {
  const result = await fixture.query<{
    cost_source: string;
    input_cost_usd: string;
    output_cost_usd: string;
    price_source: string;
    total_cost_usd: string;
  }>(
    `
      select cost_source,
             input_cost_usd::text,
             output_cost_usd::text,
             price_source,
             total_cost_usd::text
      from request_costs
      order by created_at desc
      limit 1
    `,
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    costSource: row.cost_source,
    inputCostUsd: Number(row.input_cost_usd),
    outputCostUsd: Number(row.output_cost_usd),
    priceSource: row.price_source,
    totalCostUsd: Number(row.total_cost_usd),
  };
}
