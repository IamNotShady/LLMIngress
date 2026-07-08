import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { formatConsoleTimestamp } from "../../packages/db/src/console-format";
import {
  createTestPostgresFixture,
  runMigrations,
  withPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

// Seeds the value shapes the console used to format three different ways: a
// sub-cent cost with token usage (today), an older request from a previous
// day, and a failed request with no usage or cost.
async function seedFormatterData(databaseUrl: string) {
  const agentId = randomUUID();
  const virtualModelId = randomUUID();
  const todayActivityId = randomUUID();
  const oldActivityId = randomUUID();
  const now = new Date();
  const todayStartedAt = new Date(now.getTime() - 30 * 60 * 1000);
  const oldStartedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  await withPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
       values ($1, 'format-probe-agent', 'terminal', 'llmi_format_probe', 'test-hash', true)`,
      [agentId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'format-probe-vm', 'Format probe', true)`,
      [virtualModelId],
    );

    const rows = [
      { id: todayActivityId, startedAt: todayStartedAt, status: "succeeded", httpStatus: 200 },
      { id: oldActivityId, startedAt: oldStartedAt, status: "succeeded", httpStatus: 200 },
      {
        id: randomUUID(),
        startedAt: new Date(now.getTime() - 45 * 60 * 1000),
        status: "failed",
        httpStatus: 502,
      },
    ];
    for (const row of rows) {
      await client.query(
        `insert into request_activity (
           id, request_id, agent_id, virtual_model_id, agent_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           agent_name_snapshot, virtual_model_name_snapshot
         )
         values (
           $1, $2, $3, $4, 'llmi_format_probe',
           'chat_completions', 'format-probe-model', false,
           $5, $6, 1200,
           $7, $7,
           'format-probe-agent', 'format-probe-vm'
         )`,
        [
          row.id,
          `gw_${randomUUID()}`,
          agentId,
          virtualModelId,
          row.status,
          row.httpStatus,
          row.startedAt,
        ],
      );
    }

    for (const [activityId, tokens, cost] of [
      [todayActivityId, 92_535, "0.00008428"],
      [oldActivityId, 81_269, "0.13614875"],
    ] as const) {
      await client.query(
        `insert into request_usage (
           id, request_activity_id, agent_id, virtual_model_id,
           input_tokens, output_tokens, total_tokens, token_source
         )
         values ($1, $2, $3, $4, $5, 100, $6, 'provider')`,
        [randomUUID(), activityId, agentId, virtualModelId, tokens - 100, tokens],
      );
      await client.query(
        `insert into request_costs (
           id, request_activity_id, agent_id, total_cost_usd, cost_source
         )
         values ($1, $2, $3, $4, 'provider')`,
        [randomUUID(), activityId, agentId, cost],
      );
    }
  });

  return { oldStartedAt, todayStartedAt };
}

test("console formats counts, costs, missing values and timestamps consistently across pages", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_format_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const formatterData = await seedFormatterData(fixture.databaseUrl);

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await expect(
            page.getByRole("heading", { level: 1, name: "Overview", exact: true }),
          ).toBeVisible();

          // --- Overview recent requests: full token counts, smart-precision
          // cost, em-dash blanks, and 24h-only recency.
          const recentTable = page.locator(".chart-card", { hasText: "Recent requests" });
          const todayRow = recentTable.locator("tbody tr", { hasText: "92,535" });
          await expect(todayRow).toHaveCount(1);
          await expect(todayRow).toContainText("$0.0000843");
          expect(await todayRow.locator("td").first().innerText()).toBe(
            formatConsoleTimestamp(formatterData.todayStartedAt),
          );

          const oldRow = recentTable.locator("tbody tr", { hasText: "81,269" });
          await expect(oldRow).toHaveCount(0);

          const failedRow = recentTable.locator("tbody tr", { hasText: "Failed" });
          const failedCells = await failedRow.locator("td").allInnerTexts();
          expect(failedCells).toContain("—");
          expect(failedCells.join(" ")).not.toMatch(/N\/A|Unavailable/);

          // --- Activity page shows the same request with identical formatting.
          await page.goto(`${baseUrl}/activity`);
          const activityRow = page.locator("tbody tr", { hasText: "92,535" });
          await expect(activityRow).toHaveCount(1);
          await expect(activityRow).toContainText("$0.0000843");
          const oldActivityRow = page.locator("tbody tr", { hasText: "81,269" });
          await expect(oldActivityRow).toContainText("$0.14");
          expect(await oldActivityRow.locator("td").first().innerText()).toBe(
            formatConsoleTimestamp(formatterData.oldStartedAt),
          );
          const failedActivityRow = page.locator("tbody tr", { hasText: "Failed" });
          await expect(failedActivityRow).toContainText("—");
          await expect(failedActivityRow).not.toContainText("N/A");

          // --- Usage KPIs: no eight-decimal noise.
          await page.goto(`${baseUrl}/usage`);
          const totalCostCard = page.locator(".stat-card", { hasText: "Total cost" });
          await expect(totalCostCard).not.toContainText("$0.00000000");
          await expect(totalCostCard.locator(".stat-card-value")).toHaveText(
            /^\$0\.0000843|\$0\.14/,
          );
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
