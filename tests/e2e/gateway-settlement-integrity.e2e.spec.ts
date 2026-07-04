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

const agentApiKey = "llmi_gateway_settlement_integrity_key_094";
const expectedActualCostUsd = 0.11;
const expectedActualTokens = 1200;

test("gateway streaming budget settlement late-finalizes expired reservations with actual usage", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_settlement_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=stream&usage=chat&stream_end_ms=1600`,
      virtualModelName: "vm-settlement",
    });
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
    await fixture.query(
      `
        insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
        values ($1, $2, 'budget', 'day', 1, 'usd', true)
      `,
      [randomUUID(), seeded.agentId],
    );

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_BUDGET_RESERVATION_TTL_SECONDS: "1" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-settlement",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) {
        return;
      }

      const first = await reader.read();
      expect(first.done).toBe(false);
      const reservation = await waitForPendingReservation(fixture, seeded.agentId);
      await expireReservationLikeSweeper(fixture, reservation.id, reservation.budget_period_id);

      await readRemainingStream(reader);

      await expect
        .poll(() => readBudgetSettlement(fixture, reservation.id), {
          timeout: 5_000,
        })
        .toEqual({
          actualCostUsd: expectedActualCostUsd,
          actualTotalTokens: expectedActualTokens,
          costUsedUsd: expectedActualCostUsd,
          reservedCostUsd: 0,
          reservedTokens: 0,
          status: "finalized",
          tokensUsed: expectedActualTokens,
        });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

type QueryableFixture = {
  query: <T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

async function waitForPendingReservation(
  fixture: QueryableFixture,
  agentId: string,
): Promise<{ budget_period_id: string; id: string }> {
  return expect
    .poll(async () => {
      const result = await fixture.query<{ budget_period_id: string; id: string }>(
        `
          select id::text,
                 budget_period_id::text
          from budget_reservations
          where agent_id = $1
            and status = 'pending'
          order by created_at desc
          limit 1
        `,
        [agentId],
      );
      return result.rows[0] ?? null;
    })
    .not.toBeNull()
    .then(async () => {
      const result = await fixture.query<{ budget_period_id: string; id: string }>(
        `
          select id::text,
                 budget_period_id::text
          from budget_reservations
          where agent_id = $1
          order by created_at desc
          limit 1
        `,
        [agentId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Budget reservation was not created.");
      }
      return row;
    });
}

async function expireReservationLikeSweeper(
  fixture: QueryableFixture,
  reservationId: string,
  budgetPeriodId: string,
): Promise<void> {
  await fixture.query(
    `
      update budget_periods
      set reserved_tokens = 0,
          reserved_cost_usd = 0,
          updated_at = now()
      where id = $1
    `,
    [budgetPeriodId],
  );
  await fixture.query(
    `
      update budget_reservations
      set status = 'expired',
          updated_at = now()
      where id = $1
    `,
    [reservationId],
  );
}

async function readRemainingStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
  }
}

async function readBudgetSettlement(
  fixture: QueryableFixture,
  reservationId: string,
): Promise<{
  actualCostUsd: number | null;
  actualTotalTokens: number | null;
  costUsedUsd: number;
  reservedCostUsd: number;
  reservedTokens: number;
  status: string;
  tokensUsed: number;
} | null> {
  const result = await fixture.query<{
    actual_cost_usd: string | null;
    actual_total_tokens: string | null;
    cost_used_usd: string;
    reserved_cost_usd: string;
    reserved_tokens: string;
    status: string;
    tokens_used: string;
  }>(
    `
      select budget_reservations.status,
             budget_reservations.actual_total_tokens::text,
             budget_reservations.actual_cost_usd::text,
             budget_periods.tokens_used::text,
             budget_periods.cost_used_usd::text,
             budget_periods.reserved_tokens::text,
             budget_periods.reserved_cost_usd::text
      from budget_reservations
      join budget_periods on budget_periods.id = budget_reservations.budget_period_id
      where budget_reservations.id = $1
    `,
    [reservationId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    actualCostUsd: row.actual_cost_usd === null ? null : Number(row.actual_cost_usd),
    actualTotalTokens: row.actual_total_tokens === null ? null : Number(row.actual_total_tokens),
    costUsedUsd: Number(row.cost_used_usd),
    reservedCostUsd: Number(row.reserved_cost_usd),
    reservedTokens: Number(row.reserved_tokens),
    status: row.status,
    tokensUsed: Number(row.tokens_used),
  };
}
