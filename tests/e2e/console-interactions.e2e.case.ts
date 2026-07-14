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
         route_reason,
         started_at, completed_at,
         agent_name_snapshot, virtual_model_name_snapshot
       )
       values (
         $1, 'gw_audit_old_request', $2, $3, 'llmi_audit_old',
         'chat_completions', 'audit-model', false, 'succeeded', 200, 1200,
         '{"strategy":"cost_first"}'::jsonb,
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

async function seedProviderApiKeyInteractionData(databaseUrl: string) {
  const providerId = randomUUID();
  const lifecycleKeyId = randomUUID();
  const failureKeyId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (
         id, provider_type, provider_key, display_name, base_url, enabled
       )
       values ($1, 'api_key', 'openai', 'Console Key Actions', 'https://provider.test/v1', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_api_keys (
         id, provider_id, key_prefix, encrypted_key, key_id, label, priority, enabled
       )
       values
         ($1, $2, 'life-key', '{}'::jsonb, 'test-key', 'Lifecycle key', 100, true),
         ($3, $2, 'fail-key', '{}'::jsonb, 'test-key', 'Failure key', 90, true)`,
      [lifecycleKeyId, providerId, failureKeyId],
    );
  });

  return { failureKeyId, lifecycleKeyId, providerId };
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
        await expect(page.locator(".chart-card", { hasText: "Recent requests" })).not.toContainText(
          "audit-old-agent",
        );
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
        await expect(page.locator(".stat-card", { hasText: "Total cost" })).toContainText("$0.42");

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
        await createdAgentRow.getByRole("button", { name: "Disable audit-created-agent" }).click();
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
          if (viewport.width === 390) {
            const mobilePagination = page.getByRole("navigation", { name: "Activity pages" });
            const mobileMetrics = await mobilePagination.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return {
                flexDirection: getComputedStyle(element).flexDirection,
                left: rect.left,
                right: rect.right,
                viewportWidth: document.documentElement.clientWidth,
              };
            });
            expect(mobileMetrics.flexDirection).toBe("column");
            expect(mobileMetrics.left).toBeGreaterThanOrEqual(0);
            expect(mobileMetrics.right).toBeLessThanOrEqual(mobileMetrics.viewportWidth);
          }
        }

        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
        await expect(page.locator(".activity-table tbody tr")).toHaveCount(20);
        const activityPagination = page.getByRole("navigation", { name: "Activity pages" });
        await expect(activityPagination).toHaveClass(/list-pagination/);
        await expect(activityPagination.locator(".list-pagination-summary strong")).toHaveText(
          "Page 1 of 2",
        );
        await expect(activityPagination.locator(".list-pagination-range")).toHaveText(
          "1–20 of 21 activities",
        );
        await activityPagination.getByRole("link", { name: "Next page" }).click();
        await expect(page).toHaveURL(`${baseUrl}/activity?page=2`);
        await expect(page.locator(".activity-table tbody tr")).toHaveCount(1);
        await activityPagination.getByRole("link", { name: "Previous page" }).click();
        await expect(page).toHaveURL(`${baseUrl}/activity`);
        await expect(page.locator(".activity-table tbody tr")).toHaveCount(20);

        await page.getByRole("link", { name: "gw_audit_old_request" }).click();
        const activityDetail = page.getByRole("dialog", { name: "Request detail" });
        await expect(activityDetail.getByText("Cost First", { exact: true })).toBeVisible();
        await expect(activityDetail.getByText("cost_first", { exact: true })).toHaveCount(0);

        await page.goto(`${baseUrl}/limits`, { waitUntil: "networkidle" });
        await page.getByRole("searchbox", { name: "Search limit rules" }).fill("audit-old");
        await page.getByRole("button", { name: "Search" }).click();
        await expect(page).toHaveURL(/\/limits\?q=audit-old$/);

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
  } finally {
    await fixture.dispose();
  }
});

test("Provider API key actions refresh immediately and render real failures in a toast", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_key_actions_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedProviderApiKeyInteractionData(fixture.databaseUrl);
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
      const page = await context.newPage();
      const browserErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          browserErrors.push(message.text());
        }
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));

      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/providers?selected=${seeded.providerId}`, {
          waitUntil: "networkidle",
        });

        const lifecycleRow = page.locator(".provider-key-table tbody tr", {
          hasText: "Lifecycle key",
        });
        await lifecycleRow.getByRole("button", { name: "Disable API key" }).click();
        await expect(lifecycleRow).toContainText("Disabled");
        await expect(lifecycleRow.getByRole("button", { name: "Enable API key" })).toBeVisible();
        await expect(page.getByText("Provider API key update failed.")).toHaveCount(0);
        await expect
          .poll(async () => {
            const result = await fixture.query<{ enabled: boolean }>(
              "select enabled from provider_api_keys where id = $1",
              [seeded.lifecycleKeyId],
            );
            return result.rows[0]?.enabled;
          })
          .toBe(false);

        await lifecycleRow.getByRole("button", { name: "Enable API key" }).click();
        await expect(lifecycleRow.getByRole("button", { name: "Disable API key" })).toBeVisible();
        await expect(lifecycleRow).not.toContainText("Disabled");
        await expect
          .poll(async () => {
            const result = await fixture.query<{ enabled: boolean }>(
              "select enabled from provider_api_keys where id = $1",
              [seeded.lifecycleKeyId],
            );
            return result.rows[0]?.enabled;
          })
          .toBe(true);

        await lifecycleRow.getByRole("link", { name: "Delete API key" }).click();
        const deleteDialog = page.getByRole("dialog", { name: "Delete API key?" });
        await deleteDialog.getByRole("button", { name: "Delete key" }).click();
        await expect(deleteDialog).toBeHidden();
        await expect(lifecycleRow).toHaveCount(0);
        await expect(page).toHaveURL(`${baseUrl}/providers?selected=${seeded.providerId}`);
        await expect
          .poll(async () => {
            const result = await fixture.query<{ deleted: boolean }>(
              "select deleted_at is not null as deleted from provider_api_keys where id = $1",
              [seeded.lifecycleKeyId],
            );
            return result.rows[0]?.deleted;
          })
          .toBe(true);

        const failureRow = page.locator(".provider-key-table tbody tr", {
          hasText: "Failure key",
        });
        await expect(failureRow).toBeVisible();
        await fixture.query("delete from provider_api_keys where id = $1", [seeded.failureKeyId]);
        await failureRow.getByRole("button", { name: "Disable API key" }).click();

        const toast = page.locator(".console-mutation-toast");
        await expect(toast).toBeVisible();
        await expect(toast).toHaveAttribute("role", "alert");
        await expect(failureRow.getByRole("alert")).toHaveCount(0);
        const desktopToast = await toast.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            bottom: rect.bottom,
            left: rect.left,
            position: style.position,
            right: rect.right,
            top: rect.top,
            zIndex: style.zIndex,
          };
        });
        expect(desktopToast.position).toBe("fixed");
        expect(desktopToast.zIndex).toBe("70");
        expect(desktopToast.top).toBeGreaterThanOrEqual(0);
        expect(desktopToast.right).toBeLessThanOrEqual(1280);

        await page.setViewportSize({ height: 844, width: 390 });
        const mobileToast = await toast.boundingBox();
        expect(mobileToast).not.toBeNull();
        expect(mobileToast?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((mobileToast?.x ?? 0) + (mobileToast?.width ?? 0)).toBeLessThanOrEqual(390);
        await toast.getByRole("button", { name: "Dismiss error" }).click();
        await expect(toast).toBeHidden();
        expect(
          browserErrors.filter(
            (message) => !message.startsWith("Failed to load resource: the server responded with"),
          ),
        ).toEqual([]);
      } finally {
        await context.close();
      }
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await fixture.dispose();
  }
});
