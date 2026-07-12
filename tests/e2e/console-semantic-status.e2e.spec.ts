import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
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

// Seeds the states whose meaning the console previously miscolored: a 37.5%
// failure rate (3 of 8 requests failed), an intentionally disabled provider,
// and an agent with deletable limit rules.
async function seedSemanticData(databaseUrl: string) {
  const agentId = randomUUID();
  const virtualModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into agents (id, name, key_prefix, key_hash, enabled)
       values ($1, 'semantic-probe-agent', 'llmi_semantic_probe', 'test-hash', true)`,
      [agentId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'semantic-probe-vm', 'Semantic probe', true)`,
      [virtualModelId],
    );

    for (let i = 0; i < 8; i++) {
      const failed = i < 3;
      await client.query(
        `insert into request_activity (
           id, request_id, agent_id, virtual_model_id, agent_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           agent_name_snapshot, virtual_model_name_snapshot
         )
         values (
           $1, $2, $3, $4, 'llmi_semantic_probe',
           'chat_completions', 'probe-model', false,
           $5, $6, 900,
           now() - make_interval(mins => $7), now() - make_interval(mins => $7),
           'semantic-probe-agent', 'semantic-probe-vm'
         )`,
        [
          randomUUID(),
          `gw_${randomUUID()}`,
          agentId,
          virtualModelId,
          failed ? "failed" : "succeeded",
          failed ? 502 : 200,
          i * 3,
        ],
      );
    }

    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, enabled)
       values ($1, 'api_key', 'semantic-disabled-probe', 'Semantic Disabled Probe', false)`,
      [randomUUID()],
    );

    const limitRules = [
      ["budget", "month", 100, "usd"],
      ["rpm", "minute", 600, "requests"],
    ] as const;
    for (const [limitType, period, limitValue, unit] of limitRules) {
      await client.query(
        `insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit)
         values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), agentId, limitType, period, limitValue, unit],
      );
    }
  });
}

test("console colors status by meaning and keeps destructive actions quiet but confirmed", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_semantic_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedSemanticData(fixture.databaseUrl);

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

          // --- Overview KPI deltas: activity growth reads good, unchanged
          // cost reads neutral, and the 37.5% failure rate value reads danger.
          const requestsCard = page.locator(".stat-card", { hasText: "Requests 24h" });
          await expect(requestsCard.locator(".stat-card-delta.is-good")).toBeVisible();
          const costCard = page.locator(".stat-card", { hasText: "Cost 24h" });
          await expect(costCard.locator(".stat-card-delta.is-neutral")).toBeVisible();
          const failureCard = page.locator(".stat-card", { hasText: "Failure rate" });
          await expect(failureCard.locator(".stat-card-value.is-danger")).toBeVisible();

          // --- Virtual Models: KPI and list cell mark the high failure rate.
          await page.goto(`${baseUrl}/models`);
          await expect(
            page
              .locator(".stat-card", { hasText: "Failure rate total" })
              .locator(".stat-card-value.is-danger"),
          ).toBeVisible();
          await expect(page.locator(".vm-table .num-danger").first()).toBeVisible();

          // --- Providers: an intentionally disabled provider is neutral gray,
          // not error red.
          await page.goto(`${baseUrl}/providers`);
          const disabledChip = page
            .locator(".providers-table tr", { hasText: "Semantic Disabled Probe" })
            .locator(".pill", { hasText: "Disabled" })
            .first();
          await expect(disabledChip).toBeVisible();
          await expect(disabledChip).not.toHaveClass(/pill--danger/);

          // --- Agents: the row delete action is quiet (transparent at rest).
          await page.goto(`${baseUrl}/agents`);
          const rowDelete = page.locator(".agent-action-delete").first();
          await expect(rowDelete).toBeVisible();
          expect(await rowDelete.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
            "rgba(0, 0, 0, 0)",
          );

          // --- Limits: row delete opens a confirm dialog; confirming removes
          // the rules.
          await page.goto(`${baseUrl}/limits`);
          const limitsRow = page.locator(".limits-rule-table tbody tr", {
            hasText: "semantic-probe-agent",
          });
          await expect(limitsRow).toHaveCount(1);
          await page.getByRole("link", { name: "Delete semantic-probe-agent" }).click();
          const confirmDialog = page.getByRole("dialog", {
            name: /Delete .*semantic-probe-agent.*\?/,
          });
          await expect(confirmDialog).toBeVisible();
          await confirmDialog.getByRole("button", { name: "Delete" }).click();
          await expect(
            page.locator(".limits-rule-table tbody tr", { hasText: "semantic-probe-agent" }),
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
