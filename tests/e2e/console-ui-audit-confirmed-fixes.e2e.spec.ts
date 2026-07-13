import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

async function seedAuditData(databaseUrl: string) {
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const virtualModelId = randomUUID();
  const activityId = randomUUID();
  const otherActivityId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into agents (id, name, key_prefix, key_hash, enabled)
       values
         ($1, 'audit-old-agent', 'llmi_audit_old', 'test-hash', true),
         ($2, 'audit-other-agent', 'llmi_audit_other', 'test-hash-other', true)`,
      [agentId, otherAgentId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'audit-probe-vm', 'Audit probe', true)`,
      [virtualModelId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, agent_id, virtual_model_id, agent_key_prefix,
         protocol, model, stream, status, http_status, latency_ms,
         started_at, completed_at,
         agent_name_snapshot, virtual_model_name_snapshot
       )
       values (
         $1, 'gw_audit_old_request', $2, $3, 'llmi_audit_old',
         'chat_completions', 'audit-model', false, 'succeeded', 200, 1200,
         now() - interval '3 days', now() - interval '3 days',
         'audit-old-agent', 'audit-probe-vm'
       )`,
      [activityId, agentId, virtualModelId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, agent_id, virtual_model_id, agent_key_prefix,
         protocol, model, stream, status, http_status, latency_ms,
         started_at, completed_at,
         agent_name_snapshot, virtual_model_name_snapshot
       )
       values (
         $1, 'gw_audit_other_request', $2, $3, 'llmi_audit_other',
         'chat_completions', 'audit-model', false, 'succeeded', 200, 800,
         now() - interval '3 days', now() - interval '3 days',
         'audit-other-agent', 'audit-probe-vm'
       )`,
      [otherActivityId, otherAgentId, virtualModelId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, agent_id, virtual_model_id, agent_key_prefix,
         protocol, model, stream, status, http_status, latency_ms,
         started_at, completed_at,
         agent_name_snapshot, virtual_model_name_snapshot
       )
       select
         gen_random_uuid(),
         'gw_audit_page_' || page_number,
         $1,
         $2,
         'llmi_audit_other',
         'chat_completions',
         'audit-model',
         false,
         'succeeded',
         200,
         800,
         now() - interval '4 days' - page_number * interval '1 minute',
         now() - interval '4 days' - page_number * interval '1 minute',
         'audit-other-agent',
         'audit-probe-vm'
       from generate_series(1, 19) as page_number`,
      [otherAgentId, virtualModelId],
    );
    await client.query(
      `insert into request_usage (
         id, request_activity_id, agent_id, virtual_model_id,
         input_tokens, output_tokens, total_tokens, token_source
       )
       values ($1, $2, $3, $4, 12000, 345, 12345, 'provider')`,
      [randomUUID(), activityId, agentId, virtualModelId],
    );
    await client.query(
      `insert into request_costs (
         id, request_activity_id, agent_id, total_cost_usd, cost_source
       )
       values ($1, $2, $3, '0.42', 'provider')`,
      [randomUUID(), activityId, agentId],
    );
  });

  return { agentId };
}

async function expectActivityTimeCellContained(page: Page) {
  const metrics = await page
    .locator(".activity-table tbody tr", { hasText: "gw_audit_old_request" })
    .evaluate((row) => {
      const [timeCell, requestCell] = Array.from(row.querySelectorAll("td"));
      const timeStyle = getComputedStyle(timeCell);
      return {
        requestCellOverflow: getComputedStyle(requestCell).overflow,
        timeCellClientWidth: timeCell.clientWidth,
        timeCellOverflow: timeStyle.overflow,
        timeCellScrollWidth: timeCell.scrollWidth,
      };
    });
  expect(metrics.requestCellOverflow).toBe("hidden");
  expect(
    metrics.timeCellScrollWidth <= metrics.timeCellClientWidth ||
      metrics.timeCellOverflow === "hidden",
  ).toBe(true);
}

test("console audit fixes keep time windows honest and prevent activity timestamp overlap", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_audit_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedAuditData(fixture.databaseUrl);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            consoleErrors.push(message.text());
          }
        });

        try {
          await page.addInitScript(() => {
            const applyCaretMutation = () => {
              const input = document.querySelector<HTMLInputElement>('input[name="vmQuery"]');
              if (input) {
                input.style.caretColor = "transparent";
              }
            };

            new MutationObserver(applyCaretMutation).observe(document, {
              childList: true,
              subtree: true,
            });
            applyCaretMutation();
          });

          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);

          await page.goto(baseUrl, { waitUntil: "networkidle" });
          await expect(page.locator(".stat-card", { hasText: "Requests 24h" })).toContainText("0");
          await expect(
            page.locator(".chart-card", { hasText: "Recent requests" }),
          ).not.toContainText("audit-old-agent");
          await expect(
            page.locator(".chart-card", { hasText: "Top agents by cost" }),
          ).not.toContainText("$0.42");

          await page.goto(`${baseUrl}/usage`, { waitUntil: "networkidle" });
          const daySpan = await page.evaluate(() => {
            const from = (document.querySelector("#usage-date-from") as HTMLInputElement).value;
            const to = (document.querySelector("#usage-date-to") as HTMLInputElement).value;
            return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
          });
          expect(daySpan).toBe(6);
          await expect(page.locator(".stat-card", { hasText: "Total cost" })).toContainText(
            "$0.42",
          );

          await page.goto(`${baseUrl}/agents`, { waitUntil: "networkidle" });
          await expect(page.locator(".stat-card", { hasText: "Enabled" })).toContainText("2");
          await expect(page.locator(".stat-card", { hasText: "Cost 24h" })).toContainText("$0.00");

          await page.goto(`${baseUrl}/models`, { waitUntil: "networkidle" });
          await expect(page.locator(".vm-table thead")).toContainText("Failure rate total");
          expect(consoleErrors.filter((error) => error.includes("hydration"))).toEqual([]);

          await page.goto(`${baseUrl}/agents?agentDialog=new`, { waitUntil: "networkidle" });
          await expect(page.locator("#agent-allowed-virtual-models")).toHaveCount(0);
          await expect(
            page.locator('input[name="allowedVirtualModelIds"][type="checkbox"]'),
          ).toHaveCount(1);
          await expect(page.locator("#agent-type")).toHaveCount(0);
          await page.getByLabel("Agent name").fill("audit-created-agent");
          await expect(page.getByLabel("Default virtual model").locator("option")).toHaveCount(1);
          await page.getByRole("button", { name: "Create" }).click();
          await expect(page.getByText("Select at least one allowed Virtual Model.")).toBeVisible();
          await page.getByLabel("audit-probe-vm").check();
          await expect(page.getByLabel("Default virtual model").locator("option")).toHaveCount(2);
          await page.getByLabel("Default virtual model").selectOption({ label: "audit-probe-vm" });
          await page.getByLabel("audit-probe-vm").uncheck();
          await expect(page.getByLabel("Default virtual model")).toHaveValue("");
          await page.getByLabel("audit-probe-vm").check();
          await page.getByLabel("Default virtual model").selectOption({ label: "audit-probe-vm" });
          await page.getByRole("button", { name: "Create" }).click();
          const createdAgentDialog = page.getByRole("dialog", { name: "Agent created" });
          await expect(createdAgentDialog).toBeVisible();
          await expect(createdAgentDialog).toContainText("audit-probe-vm");
          await expect(createdAgentDialog).not.toContainText("<Virtual Model Name>");
          await expect(createdAgentDialog).not.toContainText("Agent API key prefix");
          await createdAgentDialog.getByRole("link", { name: "Close" }).click();
          const createdAgentRow = page.locator(".agents-table tbody tr", {
            hasText: "audit-created-agent",
          });
          await expect(createdAgentRow).toContainText("audit-probe-vm");
          await expect(createdAgentRow).toContainText("True");
          await createdAgentRow
            .getByRole("button", { name: "Disable audit-created-agent" })
            .click();
          await expect(createdAgentRow).toContainText("False");
          await createdAgentRow.getByRole("button", { name: "Enable audit-created-agent" }).click();
          await expect(createdAgentRow).toContainText("True");

          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
            await expect(
              page.locator(".activity-table tbody tr", { hasText: "gw_audit_old_request" }),
            ).toBeVisible();
            await expectActivityTimeCellContained(page);
          }

          await page.setViewportSize({ width: 1920, height: 1080 });
          await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
          await expect(page.locator(".activity-table tbody tr")).toHaveCount(20);
          await expect(page.locator(".pager-status")).toHaveText("1–20 of 21");

          const sidebarMetrics = await page.locator(".sidebar").evaluate((sidebar) => ({
            labelFontSize: getComputedStyle(sidebar.querySelector(".nav-item-label") as HTMLElement)
              .fontSize,
            width: getComputedStyle(sidebar).width,
          }));
          expect(sidebarMetrics).toEqual({ labelFontSize: "15px", width: "280px" });

          const pageWidths: number[] = [];
          for (const path of ["/providers", "/models", "/activity", "/limits"]) {
            await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
            pageWidths.push(
              await page
                .locator(".page")
                .evaluate((pageElement) => pageElement.getBoundingClientRect().width),
            );
          }
          expect(pageWidths).toEqual([1600, 1600, 1600, 1600]);

          await page.goto(`${baseUrl}/activity?agentId=${seeded.agentId}`, {
            waitUntil: "networkidle",
          });
          await expect(page.locator("#activity-agent")).toHaveValue(seeded.agentId);
          await expect(
            page.locator(".activity-table tbody tr", { hasText: "gw_audit_old_request" }),
          ).toBeVisible();
          await expect(
            page.locator(".activity-table tbody tr", { hasText: "gw_audit_other_request" }),
          ).toHaveCount(0);
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
