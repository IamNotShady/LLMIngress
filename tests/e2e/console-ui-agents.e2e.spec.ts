import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("agents page matches the designed list and detail layout", async ({ browser }) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/agents`, { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
      await page.getByRole("link", { name: "Create Agent" }).click();
      const createDialog = page.getByRole("dialog", { name: "New agent" });
      await expect(createDialog.getByRole("heading", { name: "New agent" })).toBeVisible();
      await expect(createDialog.getByLabel("Agent name")).toBeVisible();
      const createLimitsSwitch = createDialog.getByLabel("Enable limits");
      await expect(createLimitsSwitch).not.toBeChecked();
      await expect(createDialog.getByLabel("Budget USD limit")).toBeHidden();
      await expect(createDialog.getByLabel("Alert threshold (%)")).toBeHidden();
      await expect(createDialog.getByLabel("Concurrency limit")).toBeHidden();
      await createLimitsSwitch.check();
      await expect(createDialog.getByLabel("Budget USD limit")).toBeVisible();
      await expect(createDialog.getByLabel("RPM limit")).toBeVisible();
      await expect(createDialog.getByLabel("Alert threshold (%)")).toBeVisible();
      await expect(createDialog.getByLabel("Concurrency limit")).toBeVisible();
      await createLimitsSwitch.uncheck();
      await expect(createDialog.getByLabel("Budget USD limit")).toBeHidden();
      await expect(createDialog.getByLabel("Alert threshold (%)")).toBeHidden();
      await expect(createDialog.getByLabel("Concurrency limit")).toBeHidden();
      await createDialog.getByRole("link", { name: "Close" }).click();

      for (const label of ["Agents", "Connected", "Requests 24h", "Cost 7d"]) {
        await expect(page.locator(".stat-card-label", { hasText: label })).toBeVisible();
      }

      for (const label of ["Type", "Status", "Platform"]) {
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByPlaceholder("Search agent name or note")).toBeVisible();
      await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
      const filterLayout = await readAgentFilterLayout(page);
      expect(Math.abs(filterLayout.type.y - filterLayout.status.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(filterLayout.type.y - filterLayout.platform.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(filterLayout.type.y - filterLayout.search.y)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(
          filterLayout.type.y +
            filterLayout.type.height -
            (filterLayout.actions.y + filterLayout.actions.height),
        ),
      ).toBeLessThanOrEqual(2);
      expect(filterLayout.type.x).toBeLessThan(filterLayout.status.x);
      expect(filterLayout.status.x).toBeLessThan(filterLayout.platform.x);
      expect(filterLayout.platform.x).toBeLessThan(filterLayout.search.x);
      expect(filterLayout.search.x).toBeLessThan(filterLayout.actions.x);
      expect(filterLayout.search.width).toBeGreaterThan(filterLayout.type.width * 1.5);
      expect(filterLayout.actions.x + filterLayout.actions.width).toBeLessThanOrEqual(
        filterLayout.bar.x + filterLayout.bar.width + 1,
      );
      expect(filterLayout.bar.y + filterLayout.bar.height).toBeLessThanOrEqual(
        filterLayout.list.y - 8,
      );
      await page.getByLabel("Status", { exact: true }).selectOption("offline");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/agentStatus=offline/);
      await expect(page.getByRole("row", { name: /OpenClaw/ })).toBeVisible();
      await expect(page.getByRole("row", { name: /Claude Code/ })).toHaveCount(0);
      await page.goto(`${baseUrl}/agents`);

      await expect(page.getByRole("heading", { name: "Agent list" })).toBeVisible();
      for (const header of [
        "Agent",
        "Type",
        "API Key Prefix",
        "Default VM",
        "Available VM",
        "Requests 24h",
        "24h Cost",
        "Status",
        "Action",
      ]) {
        await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
      }
      const tableColumnLayout = await readAgentTableColumnLayout(page);
      expect(tableColumnLayout.defaultVirtualModel.width).toBeLessThanOrEqual(125);
      expect(tableColumnLayout.availableVm.width).toBeLessThanOrEqual(105);
      expect(
        tableColumnLayout.defaultVirtualModel.width + tableColumnLayout.availableVm.width,
      ).toBeLessThanOrEqual(225);
      await expect(page.getByRole("row", { name: /OpenClaw/ })).toContainText("Offline");

      const details = page.getByLabel("Selected agent details");
      await expect(details.getByRole("heading", { name: "Claude Code" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Allowed Virtual Models" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Budget / Limit" })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Integration snippets" })).toHaveCount(0);
      await expect(details.getByRole("heading", { name: "Integration guide" })).toHaveCount(0);

      await expect(page.locator(".agent-management-row")).toHaveCount(0);
      await page
        .getByRole("row", { name: /Claude Code/ })
        .getByRole("link", { name: "Edit" })
        .click();
      const editDialog = page.getByRole("dialog", { name: "Edit Claude Code" });
      await expect(editDialog.getByRole("heading", { name: "Edit Claude Code" })).toBeVisible();
      await expect(editDialog.getByRole("heading", { name: "Integration snippets" })).toHaveCount(
        0,
      );
      await expect(editDialog.getByLabel("Allowed virtual models").locator("option")).toHaveText([
        "cheap",
        "coding-balanced",
        "long-context",
        "smart",
      ]);
      await expect(editDialog.getByLabel("Default virtual model").locator("option")).toHaveText([
        "No default virtual model",
        "cheap",
        "coding-balanced",
        "long-context",
        "smart",
      ]);
      const allowedToggle = editDialog.locator(".agent-vm-multi-select-button");
      await expect(allowedToggle).toBeVisible();
      const allowedToggleBox = await allowedToggle.boundingBox();
      const defaultSelectBox = await editDialog.getByLabel("Default virtual model").boundingBox();
      if (!allowedToggleBox || !defaultSelectBox) {
        throw new Error("Agent virtual model controls did not render with measurable bounds.");
      }
      expect(Math.abs(allowedToggleBox.height - defaultSelectBox.height)).toBeLessThanOrEqual(8);
      await expect(editDialog.getByLabel("Enable limits")).toBeChecked();
      await expect(editDialog.getByLabel("Budget USD limit")).toBeVisible();

      await editDialog.getByRole("link", { name: "Close" }).click();
      await page
        .getByRole("row", { name: /OpenClaw/ })
        .getByRole("link", { name: "Edit" })
        .click();
      const noLimitEditDialog = page.getByRole("dialog", { name: "Edit OpenClaw" });
      await expect(noLimitEditDialog.getByRole("heading", { name: "Edit OpenClaw" })).toBeVisible();
      await expect(noLimitEditDialog.getByLabel("Enable limits")).not.toBeChecked();
      await expect(noLimitEditDialog.getByLabel("Budget USD limit")).toBeHidden();
      await expect(noLimitEditDialog.getByLabel("Alert threshold (%)")).toBeHidden();
      await expect(noLimitEditDialog.getByLabel("Concurrency limit")).toBeHidden();
      await noLimitEditDialog.getByLabel("Enable limits").check();
      await expect(noLimitEditDialog.getByLabel("Budget USD limit")).toBeVisible();
      await expect(noLimitEditDialog.getByLabel("Alert threshold (%)")).toBeVisible();
      await expect(noLimitEditDialog.getByLabel("Concurrency limit")).toBeVisible();
      await noLimitEditDialog.getByLabel("Enable limits").uncheck();
      await expect(noLimitEditDialog.getByLabel("Budget USD limit")).toBeHidden();
      await noLimitEditDialog.getByRole("link", { name: "Close" }).click();

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

async function readAgentFilterLayout(page: import("@playwright/test").Page) {
  const layout = await page.evaluate(() => {
    const readRect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };
    };
    return {
      actions: readRect(".agents-filter-actions"),
      bar: readRect(".agents-filter-bar"),
      list: readRect(".agents-list-card"),
      platform: readRect("#agent-filter-platform"),
      search: readRect("#agent-filter-search"),
      status: readRect("#agent-filter-status"),
      type: readRect("#agent-filter-type"),
    };
  });
  return layout;
}

async function readAgentTableColumnLayout(page: import("@playwright/test").Page) {
  const layout = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll(".agents-table thead th"));
    const readHeader = (index: number) => {
      const element = headers[index];
      if (!element) {
        throw new Error(`Missing agents table header ${index}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        x: rect.x,
      };
    };
    return {
      availableVm: readHeader(4),
      defaultVirtualModel: readHeader(3),
    };
  });
  return layout;
}

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
        "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
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
      if (name !== "OpenClaw") {
        await client.query(
          `insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit)
           values
             ($1, $2, 'budget', 'month', 500, 'usd'),
             ($3, $2, 'token', 'request', 100000000, 'tokens')`,
          [randomUUID(), keyId, randomUUID()],
        );
      }
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
