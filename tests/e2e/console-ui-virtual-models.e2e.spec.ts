import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("virtual models page renders KPI cards, overview, fallback chart, and editor link", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/models`);

    await expect(
      page.getByRole("heading", { level: 1, name: "Virtual Models / Routes" }),
    ).toBeVisible();

    // KPI tiles.
    for (const label of ["Virtual Models", "Requests 24h", "Cost 24h", "Avg failure rate"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Overview panel.
    await expect(page.getByRole("heading", { name: "Virtual Model list" })).toBeVisible();
    await expect(page.getByText("No virtual models configured.")).toBeVisible();

    // Virtual Model editor entry.
    await expect(page.getByRole("link", { name: "Create Virtual Model" })).toHaveAttribute(
      "href",
      "/models?virtualModelDialog=new",
    );
  });
});

test("virtual models page uses real usage metrics instead of placeholder values", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/models`);

      await expect(page.getByRole("heading", { name: "Virtual Model list" })).toBeVisible();

      const unusedRow = page.getByRole("row", { name: /mix-unused/ });
      await expect(unusedRow.locator("td").nth(4)).toHaveText("0");
      await expect(unusedRow.locator("td").nth(5)).toHaveText("$0.00000000");
      await expect(unusedRow.locator("td").nth(6)).toHaveText("0.0%");

      const usedRow = page.getByRole("row", { name: /used-balanced/ });
      await expect(usedRow.locator("td").nth(4)).toHaveText("2");
      await expect(usedRow.locator("td").nth(5)).toHaveText("$0.04000000");
      await expect(usedRow.locator("td").nth(6)).toHaveText("50.0%");
      await page.getByRole("link", { name: "used-balanced" }).click();
      await expect(page.locator(".vm-detail-card")).toContainText("GPT-4.1 Mini");

      await page.getByRole("link", { name: "mix-unused" }).click();
      const detail = page.locator(".vm-detail-card");
      await expect(detail.getByRole("heading", { name: "mix-unused" })).toBeVisible();
      await expect(detail).toContainText("Requests 24h");
      await expect(detail).toContainText("$0.00000000");
      await expect(detail).toContainText("0.0%");
    },
    { seed: seedVirtualModelMetricData },
  );
});

async function seedVirtualModelMetricData(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const agentId = randomUUID();
    const providerId = randomUUID();
    const providerModelId = randomUUID();
    const unusedVirtualModelId = randomUUID();
    const usedVirtualModelId = randomUUID();
    const unusedRoutePolicyId = randomUUID();
    const usedRoutePolicyId = randomUUID();
    const succeededActivityId = randomUUID();
    const failedActivityId = randomUUID();

    await client.query(
      "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openai', 'OpenAI', true)",
      [providerId],
    );
    await client.query(
      "insert into provider_models (id, provider_id, model_id, display_name, availability) values ($1, $2, 'gpt-4.1-mini', 'GPT-4.1 Mini', 'available')",
      [providerModelId, providerId],
    );
    await client.query(
      `
        insert into virtual_models (id, name, description, enabled)
        values ($1, 'mix-unused', 'Mix Unused', true),
               ($2, 'used-balanced', 'Used Balanced', true)
      `,
      [unusedVirtualModelId, usedVirtualModelId],
    );
    await client.query(
      `
        insert into route_policies (id, virtual_model_id, strategy)
        values ($1, $2, 'random'),
               ($3, $4, 'random')
      `,
      [unusedRoutePolicyId, unusedVirtualModelId, usedRoutePolicyId, usedVirtualModelId],
    );
    await client.query(
      `
        insert into route_policy_candidates
          (id, route_policy_id, provider_model_id, candidate_order)
        values ($1, $2, $3, 1),
               ($4, $5, $3, 1)
      `,
      [randomUUID(), unusedRoutePolicyId, providerModelId, randomUUID(), usedRoutePolicyId],
    );
    await client.query(
      `insert into agents
         (id, name, agent_type, key_prefix, key_hash, default_virtual_model_id, enabled)
       values ($1, 'Metric Agent', 'coding', 'metric001', 'sha256:v1:metric', $2, true)`,
      [agentId, usedVirtualModelId],
    );
    await client.query(
      `
        insert into request_activity
          (id, request_id, agent_id, virtual_model_id, route_policy_id, provider_id,
           provider_model_id, agent_key_prefix, protocol, model, status, http_status,
           latency_ms, started_at, completed_at)
        values
          ($1, 'req_vm_metric_success', $2, $3, $4, $5, $6, 'metric001',
           'chat_completions', 'used-balanced', 'succeeded', 200, 120, now(), now()),
          ($7, 'req_vm_metric_failure', $2, $3, $4, $5, $6, 'metric001',
           'chat_completions', 'used-balanced', 'failed', 502, 340, now(), now())
      `,
      [
        succeededActivityId,
        agentId,
        usedVirtualModelId,
        usedRoutePolicyId,
        providerId,
        providerModelId,
        failedActivityId,
      ],
    );
    await client.query(
      `
        insert into request_costs
          (id, request_activity_id, agent_id, provider_model_id, total_cost_usd, cost_source)
        values ($1, $2, $3, $4, 0.01, 'provider'),
               ($5, $6, $3, $4, 0.03, 'provider')
      `,
      [randomUUID(), succeededActivityId, agentId, providerModelId, randomUUID(), failedActivityId],
    );
    await client.query(
      `
        insert into fallback_events
          (id, request_activity_id, provider_model_id, attempt_order, status, error_code)
        values ($1, $2, $3, 1, 'failed', 'upstream_error')
      `,
      [randomUUID(), failedActivityId, providerModelId],
    );
  } finally {
    await client.end();
  }
}
