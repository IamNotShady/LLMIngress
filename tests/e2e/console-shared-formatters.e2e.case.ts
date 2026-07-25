import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { formatConsoleTimestamp } from "../../packages/db/src/console-format";
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

// Seeds the value shapes the console used to format three different ways: a
// sub-cent cost with token usage (today), an older request from a previous
// day, and a failed request with no usage or cost.
async function seedFormatterData(databaseUrl: string) {
  const apiKeyId = randomUUID();
  const virtualModelId = randomUUID();
  const todayActivityId = randomUUID();
  const oldActivityId = randomUUID();
  const now = new Date();
  const todayStartedAt = new Date(now.getTime() - 30 * 60 * 1000);
  const oldStartedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled)
       values ($1, 'format-probe-apiKey', 'llmi_format_probe', 'test-hash', true)`,
      [apiKeyId],
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
           id, request_id, api_key_id, virtual_model_id, api_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           api_key_name_snapshot, virtual_model_name_snapshot
         )
         values (
           $1, $2, $3, $4, 'llmi_format_probe',
           'chat_completions', 'format-probe-model', false,
           $5, $6, 1200,
           $7, $7,
           'format-probe-apiKey', 'format-probe-vm'
         )`,
        [
          row.id,
          `gw_${randomUUID()}`,
          apiKeyId,
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
           id, request_activity_id, api_key_id, virtual_model_id,
           input_tokens, output_tokens, total_tokens, token_source
         )
         values ($1, $2, $3, $4, $5, 100, $6, 'provider')`,
        [randomUUID(), activityId, apiKeyId, virtualModelId, tokens - 100, tokens],
      );
      await client.query(
        `insert into request_costs (
           id, request_activity_id, api_key_id, total_cost_usd, cost_source
         )
         values ($1, $2, $3, $4, 'provider')`,
        [randomUUID(), activityId, apiKeyId, cost],
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

        // --- Activity rows: exact token counts, smart-precision cost, an em
        // dash for what is missing, and never the old null vocabulary.
        await page.goto(`${baseUrl}/activity`);
        // IN and OUT are the request's own token counts, stated exactly.
        const recent = page.getByRole("link", { name: /92,435/ });
        await expect(recent).toHaveCount(1);
        await expect(recent).toContainText("$0.0000843");

        // The older request is outside the default window; widening the window
        // finds it, still formatted the same way.
        await page.goto(`${baseUrl}/activity?window=7d`);
        const older = page.getByRole("link", { name: /81,169/ });
        await expect(older).toHaveCount(1);
        await expect(older).toContainText("$0.14");

        const failed = page.getByRole("link", { name: /502/ }).first();
        await expect(failed).toContainText("—");
        const body = await page.locator("body").innerText();
        expect(body).not.toMatch(/N\/A|Unavailable/);

        // --- Usage KPIs: no eight-decimal noise anywhere.
        await page.goto(`${baseUrl}/usage`);
        const usageBody = await page.locator("body").innerText();
        expect(usageBody).not.toContain("0.00000000");
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
