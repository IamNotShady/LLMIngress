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

// Well past every cap the page draws, so a list that forgot one is obvious.
const PROVIDER_COUNT = 9;
const API_KEY_COUNT = 11;

const CONNECTION_HEALTH_ROWS = 4;
const PLAN_QUOTA_ROWS = 2;
const BREAKDOWN_ROWS = 8;
const RECENT_FAILURE_ROWS = 5;

async function seedCrowdedConsole(databaseUrl: string): Promise<void> {
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    const virtualModelId = randomUUID();
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'caps-vm', 'Caps VM', true)`,
      [virtualModelId],
    );
    await client.query(
      `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
       values ($1, $2, 'fixed', 'chat_completions')`,
      [randomUUID(), virtualModelId],
    );

    const targets: Array<{ providerId: string; providerModelId: string }> = [];
    for (let index = 0; index < PROVIDER_COUNT; index++) {
      const providerId = randomUUID();
      const connectionId = randomUUID();
      const providerModelId = randomUUID();
      targets.push({ providerId, providerModelId });
      await client.query(
        `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
         values ($1, 'api_key', 'deepseek', $2, 'https://caps.test/v1', true)`,
        [providerId, `caps-provider-${String(index).padStart(2, "0")}`],
      );
      await client.query(
        `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, label)
         values ($1, $2, 'caps', '{"version":1}'::jsonb, 'test-key', $3)`,
        [connectionId, providerId, `caps-conn-${index}`],
      );
      await client.query(
        `insert into provider_models (id, provider_id, model_id, display_name, availability)
         values ($1, $2, $3, $3, 'available')`,
        [providerModelId, providerId, `caps-model-${index}`],
      );
      // Every connection reports a rolling window, so Plan quota has more rows
      // than it draws and has to choose between them.
      await client.query(
        `insert into provider_quota_summary (id, provider_id, provider_connection_id, entries, observed_at)
         values ($1, $2, $3, $4::jsonb, now())`,
        [
          randomUUID(),
          providerId,
          connectionId,
          JSON.stringify([
            { resetAt: null, utilization: 0.1 + index * 0.09, window: "5h", windowLabel: "5h" },
          ]),
        ],
      );
    }

    for (let index = 0; index < API_KEY_COUNT; index++) {
      const apiKeyId = randomUUID();
      await client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled)
         values ($1, $2, $3, gen_random_uuid()::text, true)`,
        [apiKeyId, `caps-key-${String(index).padStart(2, "0")}`, `llmi_caps${index}`],
      );
      await client.query(
        `insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)`,
        [apiKeyId, virtualModelId],
      );
      // Two requests each, one of them failed, so both usage tables and the
      // failures list have more rows than they draw.
      const target = targets[index % targets.length] as (typeof targets)[number];
      for (const failed of [false, true]) {
        const activityId = randomUUID();
        await client.query(
          `insert into request_activity (
             id, request_id, api_key_id, virtual_model_id, provider_id, provider_model_id,
             api_key_prefix, protocol, model, stream, status, http_status, error_code, latency_ms,
             started_at, completed_at, api_key_name_snapshot, virtual_model_name_snapshot
           )
           values ($1, $2, $3, $4, $5, $6, 'llmi_caps', 'chat_completions', 'caps-vm', false,
                   $7, $8, $11, 120, now() - make_interval(mins => $9), now() - make_interval(mins => $9),
                   $10, 'caps-vm')`,
          [
            activityId,
            `caps-${activityId}`,
            apiKeyId,
            virtualModelId,
            target.providerId,
            target.providerModelId,
            failed ? "failed" : "succeeded",
            failed ? 429 : 200,
            index + (failed ? 1 : 0),
            `caps-key-${String(index).padStart(2, "0")}`,
            failed ? "rate_limit" : null,
          ],
        );
        await client.query(
          `insert into request_usage (
             id, request_activity_id, api_key_id, virtual_model_id, provider_model_id,
             input_tokens, output_tokens, total_tokens, token_source
           ) values ($1, $2, $3, $4, $5, 100, 20, 120, 'provider')`,
          [randomUUID(), activityId, apiKeyId, virtualModelId, target.providerModelId],
        );
      }
    }
  });
}

test("the Overview caps every list it draws, and says what it is not showing", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_overview_caps_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedCrowdedConsole(fixture.databaseUrl);

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
        await page.setViewportSize({ width: 1440, height: 1000 });
        await signInFromFirstRun(page, baseUrl);
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

        // Connection health: the connections it draws, plus one row standing in
        // for the rest.
        const health = page.getByTestId("overview-connection-health");
        await expect(health.getByText("caps-provider-", { exact: false })).toHaveCount(
          CONNECTION_HEALTH_ROWS,
        );
        await expect(
          health.getByText(`${PROVIDER_COUNT - CONNECTION_HEALTH_ROWS} more healthy connections`),
        ).toBeVisible();

        // Plan quota: the plans closest to their ceiling, and a count of the
        // ones with more room.
        const quota = page.getByTestId("overview-plan-quota");
        await expect(quota.getByText("% used", { exact: false })).toHaveCount(PLAN_QUOTA_ROWS);
        await expect(
          quota.getByText(`${PROVIDER_COUNT - PLAN_QUOTA_ROWS} more plans with more room`),
        ).toBeVisible();
        // The ones it keeps are the closest to their ceiling: the busiest plan
        // is here and the quietest is not.
        await expect(quota.getByText("82% used")).toBeVisible();
        await expect(quota.getByText("10% used")).toHaveCount(0);

        // Recent failures: the query itself is the cap.
        await expect(
          page.getByTestId("overview-recent-failures").getByText("429 rate_limit"),
        ).toHaveCount(RECENT_FAILURE_ROWS);

        // Both usage tables: the busiest rows, and how many are left.
        const byKey = page.getByTestId("overview-usage-api-keys");
        await expect(byKey.getByText("caps-key-", { exact: false })).toHaveCount(BREAKDOWN_ROWS);
        await expect(
          byKey.getByText(`${API_KEY_COUNT - BREAKDOWN_ROWS} more in Usage`, { exact: false }),
        ).toBeVisible();
        const byProvider = page.getByTestId("overview-usage-providers");
        await expect(byProvider.getByText("caps-provider-", { exact: false })).toHaveCount(
          BREAKDOWN_ROWS,
        );
        await expect(
          byProvider.getByText(`${PROVIDER_COUNT - BREAKDOWN_ROWS} more in Usage`, {
            exact: false,
          }),
        ).toBeVisible();

        // The page a capped list points at still holds everything.
        await page.goto(`${baseUrl}/usage`, { waitUntil: "networkidle" });
        await expect(page.getByText("caps-key-", { exact: false })).toHaveCount(API_KEY_COUNT);
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

test("the Overview's failures are the selected window's failures", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_overview_window_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      const apiKeyId = randomUUID();
      const virtualModelId = randomUUID();
      await client.query(
        `insert into virtual_models (id, name, description, enabled)
         values ($1, 'window-vm', 'Window VM', true)`,
        [virtualModelId],
      );
      await client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled)
         values ($1, 'window-key', 'llmi_window', gen_random_uuid()::text, true)`,
        [apiKeyId],
      );
      // One failure inside the default window, one from three days ago.
      for (const failure of [
        { ageDays: 0, code: "today_failure" },
        { ageDays: 3, code: "old_failure" },
      ]) {
        await client.query(
          `insert into request_activity (
             id, request_id, api_key_id, virtual_model_id, api_key_prefix, protocol, model,
             stream, status, http_status, error_code, latency_ms, started_at, completed_at,
             api_key_name_snapshot, virtual_model_name_snapshot
           )
           values ($1, $2, $3, $4, 'llmi_window', 'chat_completions', 'window-vm', false,
                   'failed', 500, $5, 120,
                   now() - make_interval(days => $6), now() - make_interval(days => $6),
                   'window-key', 'window-vm')`,
          [
            randomUUID(),
            `window-${randomUUID()}`,
            apiKeyId,
            virtualModelId,
            failure.code,
            failure.ageDays,
          ],
        );
      }
    });

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

        // The panel sits under a chart of the last 24 hours and says so: a
        // failure from three days ago is not part of what this page describes,
        // and the sentence under the list used to claim a horizon the query
        // never applied.
        await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
        const failures = page.getByTestId("overview-recent-failures");
        await expect(failures.getByText("500 today_failure")).toBeVisible();
        await expect(failures.getByText("500 old_failure")).toHaveCount(0);
        await expect(failures.getByText("in the selected window")).toBeVisible();

        // Widening the window brings it in, which is what makes the sentence
        // true rather than decorative.
        await page.goto(`${baseUrl}/?window=7d`, { waitUntil: "networkidle" });
        await expect(failures.getByText("500 old_failure")).toBeVisible();
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
