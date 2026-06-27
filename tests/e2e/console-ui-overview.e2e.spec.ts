import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("overview dashboard renders KPI cards, recent requests, gateway status, and charts", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(baseUrl);

      // Page heading.
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await expect(
        page.getByText("Gateway status and last 24h key metrics at a glance."),
      ).toBeVisible();
      await expect(page.getByText("today's key metrics")).toHaveCount(0);

      // The six KPI metric tiles.
      for (const label of [
        "Requests 24h",
        "Cost 24h",
        "Tokens 24h",
        "Failure rate",
        "Savings",
        "Active agents 24h",
      ]) {
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByText("vs previous 24h +200.0%")).toBeVisible();
      await expect(page.getByText("vs yesterday")).toHaveCount(0);

      // The dashboard panels and charts.
      await expect(page.getByRole("heading", { name: "Recent requests" })).toBeVisible();
      for (const header of [
        "Time",
        "Agent",
        "Virtual model",
        "Hit model",
        "Provider",
        "Tokens",
        "Cost",
        "Status",
      ]) {
        await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: "Gateway status" })).toBeVisible();
      await expect(page.getByText("Running normally")).toBeVisible();
      await expect(page.getByText("Heartbeat healthy")).toBeVisible();
      await expect(page.getByText("Config version")).toBeVisible();
      await expect(page.getByText("Gateway running")).toHaveCount(0);
      await expect(page.getByText("All systems normal")).toHaveCount(0);
      await expect(page.getByText("v0.1.0")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Requests & cost trend" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Requests and cost trend" })).not.toContainText(
        "2400",
      );
      await expect(page.getByRole("heading", { name: "Top agents by cost" })).toBeVisible();
      await expect(page.getByRole("img", { name: "Top agents by cost" })).toBeVisible();
    },
    { seed: seedOverviewData },
  );
});

async function seedOverviewData(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const agentId = randomUUID();
    const keyId = randomUUID();
    const providerId = randomUUID();
    const modelId = randomUUID();
    const virtualModelId = randomUUID();
    const requestId = randomUUID();
    const previousRequestId = randomUUID();

    await client.query("insert into config_versions (version, source) values (1, 'console')");
    await client.query(
      `insert into gateway_runtime_status
         (id, gateway_instance_id, status, applied_config_version, heartbeat_at, started_at)
       values ($1, 'gateway', 'ready', 1, now(), now() - interval '2 hours')`,
      [randomUUID()],
    );
    await client.query(
      "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openai', 'OpenAI', true)",
      [providerId],
    );
    await client.query(
      "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, 'gpt-4o-mini', 'GPT-4o Mini')",
      [modelId, providerId],
    );
    await client.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, 'smart', 'Smart', true)",
      [virtualModelId],
    );
    await client.query(
      "insert into agents (id, name, agent_type, enabled) values ($1, 'Codex', 'coding', true)",
      [agentId],
    );
    await client.query(
      `update agents set id = $1, key_prefix = 'codex000', key_hash = 'sha256:v1:overview', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2`,
      [keyId, agentId, virtualModelId],
    );
    await client.query(
      `insert into request_activity
         (id, request_id, agent_id, virtual_model_id, provider_id, provider_model_id,
          agent_key_prefix, protocol, model, status, http_status, latency_ms, started_at, completed_at)
       values ($1, 'req_overview_seed', $2, $3, $4, $5, 'codex000',
          'chat_completions', 'smart', 'succeeded', 200, 240, now(), now())`,
      [requestId, keyId, virtualModelId, providerId, modelId],
    );
    await client.query(
      `insert into request_activity
         (id, request_id, agent_id, virtual_model_id, provider_id, provider_model_id,
          agent_key_prefix, protocol, model, status, http_status, latency_ms, started_at, completed_at)
       values ($1, 'req_overview_previous_seed', $2, $3, $4, $5, 'codex000',
          'chat_completions', 'smart', 'succeeded', 200, 180,
          now() - interval '25 hours', now() - interval '25 hours')`,
      [previousRequestId, keyId, virtualModelId, providerId, modelId],
    );
    await client.query(
      `insert into request_usage
         (id, request_activity_id, agent_id, virtual_model_id, provider_model_id,
          input_tokens, output_tokens, total_tokens, token_source)
       values ($1, $2, $3, $4, $5, 1000, 234, 1234, 'provider')`,
      [randomUUID(), requestId, keyId, virtualModelId, modelId],
    );
    await client.query(
      `insert into request_usage
         (id, request_activity_id, agent_id, virtual_model_id, provider_model_id,
          input_tokens, output_tokens, total_tokens, token_source)
       values ($1, $2, $3, $4, $5, 800, 200, 1000, 'provider')`,
      [randomUUID(), previousRequestId, keyId, virtualModelId, modelId],
    );
    await client.query(
      `insert into request_costs
         (id, request_activity_id, agent_id, provider_model_id,
          input_cost_usd, output_cost_usd, total_cost_usd, cost_source)
       values ($1, $2, $3, $4, 0.01, 0.02, 0.03, 'provider')`,
      [randomUUID(), requestId, keyId, modelId],
    );
    await client.query(
      `insert into request_costs
         (id, request_activity_id, agent_id, provider_model_id,
          input_cost_usd, output_cost_usd, total_cost_usd, cost_source)
       values ($1, $2, $3, $4, 0.004, 0.006, 0.01, 'provider')`,
      [randomUUID(), previousRequestId, keyId, modelId],
    );
  } finally {
    await client.end();
  }
}
