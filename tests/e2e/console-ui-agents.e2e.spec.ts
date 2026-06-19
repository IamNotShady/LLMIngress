import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("agents page matches the designed list and detail layout", async ({ browser }) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/agents`);

      await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
      await page.getByRole("link", { name: "+ Create Agent" }).click();
      const createDialog = page.getByRole("dialog", { name: "New agent" });
      await expect(createDialog.getByRole("heading", { name: "New agent" })).toBeVisible();
      await expect(createDialog.getByLabel("Agent name")).toBeVisible();
      await createDialog.getByRole("link", { name: "Close" }).click();

      for (const label of ["Agents", "Connected", "Requests today", "Cost this week"]) {
        await expect(page.locator(".stat-card-label", { hasText: label })).toBeVisible();
      }

      for (const label of ["Type", "Status", "Platform"]) {
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByPlaceholder("Search agent name or note")).toBeVisible();

      await expect(page.getByRole("heading", { name: "Agent list" })).toBeVisible();
      for (const header of [
        "Agent",
        "Type",
        "API Key Prefix",
        "Default Virtual Model",
        "Available VM",
        "Requests today",
        "Today Cost",
        "Status",
        "Action",
      ]) {
        await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
      }

      const details = page.getByLabel("Selected agent details");
      await expect(details.getByRole("heading", { name: "Claude Code" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "API Key" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Allowed Virtual Models" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Budget / Limit" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Integration guide" })).toHaveCount(0);

      await expect(page.getByText("Manage agents", { exact: true })).toBeVisible();
      await page
        .getByRole("row", { name: /Claude Code/ })
        .getByRole("link", { name: "Edit" })
        .click();
      const editDialog = page.getByRole("dialog", { name: "Edit Claude Code" });
      await expect(editDialog.getByRole("heading", { name: "Edit Claude Code" })).toBeVisible();
      await expect(editDialog.getByRole("heading", { name: "Integration snippets" })).toBeVisible();

      for (const hiddenText of [
        /^Integration platform:/,
        /^Derived status:/,
        /^Request logging:/,
        /^API key saved:/,
        /^Request attribution records:/,
        /^Agent API key prefix:/,
        /^Agent API key created:/,
        /^Agent API key updated:/,
        /^Allowed Virtual Models:/,
        /^Default Virtual Model:/,
        /^Budget Limit:/,
        /^RPM Limit:/,
        /^TPM Limit:/,
        /^Token Limit:/,
      ]) {
        await expect(page.getByText(hiddenText)).toHaveCount(0);
      }
    },
    { seed: seedAgentsData },
  );
});

async function seedAgentsData(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const virtualModels = [
      ["coding-balanced", "Coding Balanced"],
      ["smart", "Smart"],
      ["long-context", "Long Context"],
      ["cheap", "Cheap"],
    ].map(([name, displayName]) => ({ displayName, id: randomUUID(), name }));
    const agents = [
      ["Claude Code", "terminal", "claude001", "coding-balanced", 4312, 6.45],
      ["Codex", "coding", "codex001", "smart", 3652, 4.32],
      ["Cursor", "ide", "cursor001", "coding-balanced", 7245, 9.21],
      ["Hermes", "desktop", "hermes01", "cheap", 1326, 1.13],
      ["OpenCode", "ide", "opencode", "long-context", 2145, 2.34],
      ["OpenClaw", "other", "openclaw", "smart", 0, 0],
    ] as const;

    for (const virtualModel of virtualModels) {
      await client.query(
        "insert into virtual_models (id, name, display_name, enabled) values ($1, $2, $3, true)",
        [virtualModel.id, virtualModel.name, virtualModel.displayName],
      );
    }

    for (const [name, agentType, keyPrefix, defaultModelName, requestCount, cost] of agents) {
      const agentId = randomUUID();
      const keyId = randomUUID();
      const defaultModel = virtualModels.find((model) => model.name === defaultModelName);
      if (!defaultModel) {
        throw new Error(`Missing virtual model ${defaultModelName}.`);
      }
      await client.query(
        "insert into agents (id, name, agent_type, enabled, created_at) values ($1, $2, $3, true, '2025-05-10T10:21:00Z')",
        [agentId, name, agentType],
      );
      await client.query(
        `update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2`,
        [keyId, agentId, keyPrefix, `sha256:v1:${keyPrefix}`, defaultModel.id],
      );
      for (const virtualModel of virtualModels.slice(0, name === "Claude Code" ? 4 : 3)) {
        await client.query(
          "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
          [keyId, virtualModel.id],
        );
      }
      await client.query(
        `insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit)
         values
           ($1, $2, 'budget', 'month', 500, 'usd'),
           ($3, $2, 'token', 'request', 100000000, 'tokens')`,
        [randomUUID(), keyId, randomUUID()],
      );
      if (requestCount > 0) {
        const requestActivityId = randomUUID();
        await client.query(
          `insert into request_activity
             (id, request_id, agent_id, agent_key_prefix, protocol, model, status, started_at)
           values ($1, $2, $3, $4, 'chat_completions', $5, 'succeeded', now())`,
          [requestActivityId, randomUUID(), keyId, keyPrefix, defaultModel.name],
        );
        await client.query(
          `insert into request_costs
             (id, request_activity_id, agent_id, total_cost_usd, cost_source)
           values ($1, $2, $3, $4, 'provider')`,
          [randomUUID(), requestActivityId, keyId, cost],
        );
      }
    }
  } finally {
    await client.end();
  }
}
