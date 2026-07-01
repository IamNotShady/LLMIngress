import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("usage & cost page renders reference filters, KPI cards, charts, savings, and summary table", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/usage`);

    await expect(page.getByRole("heading", { level: 1, name: "Usage & Cost" })).toBeVisible();

    for (const label of ["Start date", "End date", "Agent", "Virtual Model", "Provider"]) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByLabel("Start date", { exact: true })).toHaveAttribute("type", "date");
    await expect(page.getByLabel("End date", { exact: true })).toHaveAttribute("type", "date");

    // KPI tiles (scoped to stat-card labels — savings is also repeated in the side panel).
    for (const label of [
      "Total cost",
      "Total tokens",
      "Total requests",
      "Avg latency",
      "Failure rate",
      "Estimated savings",
    ]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    for (const title of [
      "Cost trend",
      "Tokens trend",
      "Savings overview",
      "Agent cost distribution",
      "Virtual Model cost distribution",
      "Provider cost distribution",
      "Provider / Model summary",
    ]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }

    const table = page.getByRole("table");
    for (const column of [
      "Provider",
      "Model",
      "Requests",
      "Tokens",
      "Cost",
      "Avg latency",
      "Failure rate",
      "Savings",
    ]) {
      await expect(table.getByRole("columnheader", { name: column })).toBeVisible();
    }
  });
});

test("usage date filters use native date inputs", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/usage`);

    const startDateInput = page.getByLabel("Start date", { exact: true });
    const endDateInput = page.getByLabel("End date", { exact: true });
    await expect(startDateInput).toHaveAttribute("type", "date");
    await expect(endDateInput).toHaveAttribute("type", "date");

    await startDateInput.fill("2026-06-01");
    await endDateInput.fill("2026-06-30");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page).toHaveURL(/dateFrom=2026-06-01/);
    await expect(page).toHaveURL(/dateTo=2026-06-30/);
  });
});

test("usage virtual model filter shows virtual model names without descriptions", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/usage`);

      await expect(page.locator("select#usage-virtual-model option")).toHaveText([
        "All virtual models",
        "gpt55",
        "opus48",
        "random",
      ]);
    },
    { seed: seedUsageVirtualModels },
  );
});

test("usage page applies displayed default dates before Apply is clicked", async ({ browser }) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/usage`);

      await expect(
        page.locator(".stat-card", { hasText: "Total requests" }).locator(".stat-card-value"),
      ).toHaveText("1");
      await expect(page.getByRole("cell", { name: "Default Date Provider" })).toBeVisible();
    },
    { seed: seedDefaultDateUsage },
  );
});

async function seedUsageVirtualModels(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const [name, description] of [
      ["gpt55", "openai codex"],
      ["opus48", "claude opus"],
      ["random", "random open ai completion"],
    ] as const) {
      await client.query(
        "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
        [randomUUID(), name, description],
      );
    }
  } finally {
    await client.end();
  }
}

async function seedDefaultDateUsage(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const ids = {
      agentId: randomUUID(),
      providerId: randomUUID(),
      providerModelId: randomUUID(),
      virtualModelId: randomUUID(),
      requestActivityId: randomUUID(),
    };
    await client.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'Default Date Provider', 'https://default-date.example/v1', true)
      `,
      [ids.providerId],
    );
    await client.query(
      `
        insert into provider_models (id, provider_id, model_id, display_name, availability)
        values ($1, $2, 'default-date-model', 'Default Date Model', 'available')
      `,
      [ids.providerModelId, ids.providerId],
    );
    await client.query(
      `
        insert into virtual_models (id, name, description, enabled)
        values ($1, 'default-date-vm', 'Default date usage model', true)
      `,
      [ids.virtualModelId],
    );
    await client.query(
      `
        insert into agents (
          id, name, agent_type, key_prefix, key_hash, default_virtual_model_id, enabled
        )
        values ($1, 'Default Date Agent', 'coding', 'usage-default-date', 'hash-default-date', $2, true)
      `,
      [ids.agentId, ids.virtualModelId],
    );
    await client.query(
      `
        insert into request_activity (
          id, request_id, agent_id, virtual_model_id, provider_id, provider_model_id,
          agent_key_prefix, protocol, model, stream, status, http_status, latency_ms,
          started_at, completed_at
        )
        values (
          $1, 'req_usage_default_date', $2, $3, $4, $5,
          'usage-default-date', 'chat_completions', 'default-date-vm', false,
          'succeeded', 200, 100,
          date_trunc('day', now()) - interval '1 day',
          date_trunc('day', now()) - interval '1 day' + interval '100 milliseconds'
        )
      `,
      [ids.requestActivityId, ids.agentId, ids.virtualModelId, ids.providerId, ids.providerModelId],
    );
    await client.query(
      `
        insert into request_usage (
          id, request_activity_id, agent_id, virtual_model_id, provider_model_id,
          input_tokens, output_tokens, total_tokens, token_source
        )
        values ($1, $2, $3, $4, $5, 10, 20, 30, 'estimated')
      `,
      [randomUUID(), ids.requestActivityId, ids.agentId, ids.virtualModelId, ids.providerModelId],
    );
    await client.query(
      `
        insert into request_costs (
          id, request_activity_id, agent_id, provider_model_id, total_cost_usd,
          cost_source, actual_cost_usd, baseline_cost_usd, savings_usd
        )
        values ($1, $2, $3, $4, 0.00010000, 'estimated', 0.00010000, 0.00020000, 0.00010000)
      `,
      [randomUUID(), ids.requestActivityId, ids.agentId, ids.providerModelId],
    );
  } finally {
    await client.end();
  }
}
