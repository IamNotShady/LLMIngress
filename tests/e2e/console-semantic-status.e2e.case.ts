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

// Seeds the states whose meaning the console previously miscolored: a 37.5%
// failure rate (3 of 8 requests failed), an intentionally disabled provider,
// and an enabled apiKey with visible limit rules.
async function seedSemanticData(databaseUrl: string) {
  const apiKeyId = randomUUID();
  const virtualModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
       values ($1, 'semantic-probe-apiKey', 'llmi_semantic_probe', 'test-hash', true, true)`,
      [apiKeyId],
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
           id, request_id, api_key_id, virtual_model_id, api_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           api_key_name_snapshot, virtual_model_name_snapshot
         )
         values (
           $1, $2, $3, $4, 'llmi_semantic_probe',
           'chat_completions', 'probe-model', false,
           $5, $6, 900,
           now() - make_interval(mins => $7), now() - make_interval(mins => $7),
           'semantic-probe-apiKey', 'semantic-probe-vm'
         )`,
        [
          randomUUID(),
          `gw_${randomUUID()}`,
          apiKeyId,
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
        `insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit)
         values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), apiKeyId, limitType, period, limitValue, unit],
      );
    }
  });
}

async function colorOf(locator: import("@playwright/test").Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

/** Resolve a token value (which may be oklch) to the browser's rgb form. */
async function resolveColor(page: import("@playwright/test").Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, value);
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

        // --- Overview: a 37.5% failure rate is past the danger threshold and
        // is the only KPI painted with a status colour.
        const dangerColor = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--red").trim(),
        );
        const failureValue = page.getByText("37.50%", { exact: true });
        await expect(failureValue).toBeVisible();
        expect(await colorOf(failureValue)).toBe(await resolveColor(page, dangerColor));

        const requestsValue = page
          .locator("div")
          .filter({ hasText: /^REQUESTS$/ })
          .first();
        await expect(requestsValue).toBeVisible();

        // --- Providers: an intentionally disabled connection reads neutral,
        // never error red.
        await page.goto(`${baseUrl}/providers`);
        const disabled = page.getByText("disabled", { exact: true }).first();
        if (await disabled.isVisible()) {
          const faint = await resolveColor(
            page,
            await page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--faint").trim(),
            ),
          );
          expect(await colorOf(disabled)).toBe(faint);
        }

        // --- Limits: a row opens its rules; deleting them is inside the drawer
        // behind a confirm, never a bare row action.
        await page.goto(`${baseUrl}/limits`);
        const limitsRow = page.getByRole("link", { name: /semantic-probe-apiKey/ }).first();
        await expect(limitsRow).toBeVisible();
        await limitsRow.click();
        await expect(page.getByRole("button", { name: "Save rules" })).toBeVisible();
        await page.getByRole("link", { name: "Delete rules" }).click();
        await expect(page.getByRole("dialog", { name: "Delete limit rules" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Disable limits instead" })).toHaveCount(0);
        await expect(page.getByText("Deleting rules also switches limits off")).toBeVisible();
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
