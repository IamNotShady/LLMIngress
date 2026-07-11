import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
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

const MODEL_COUNT = 60;

// Seeds a provider with 60 models (the shape that rendered an 8500px page),
// plus agents so the Agents KPI cards carry real values on mobile.
async function seedIaData(databaseUrl: string) {
  const providerId = randomUUID();

  await withPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, enabled)
       values ($1, 'api_key', 'ia-probe-provider', 'IA Probe Provider', true)`,
      [providerId],
    );
    for (let i = 0; i < MODEL_COUNT; i++) {
      await client.query(
        `insert into provider_models (id, provider_id, model_id, display_name)
         values ($1, $2, $3, $4)`,
        [
          randomUUID(),
          providerId,
          i === 0 ? "ia-needle-model" : `ia-model-${String(i).padStart(3, "0")}`,
          i === 0 ? "IA Needle Model" : `IA Model ${i}`,
        ],
      );
    }
    for (let i = 0; i < 3; i++) {
      await client.query(
        `insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
         values ($1, $2, 'terminal', $3, $4, true)`,
        [randomUUID(), `ia-probe-agent-${i}`, `llmi_ia_probe_${i}`, `test-hash-${i}`],
      );
    }
  });
}

test("providers page shows one provider representation with a searchable capped model library; agents KPIs and settings forms behave on mobile", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_ia_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedIaData(fixture.databaseUrl);

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

          // --- Providers: no duplicate card grid; the list is the single
          // representation and the model library is capped and searchable.
          await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
          await expect(page.locator(".provider-card-grid")).toHaveCount(0);
          await expect(page.locator(".provider-summary-card")).toHaveCount(0);
          await expect(
            page.locator(".providers-list-card tr", { hasText: "IA Probe Provider" }).first(),
          ).toBeVisible();

          const libraryRows = page.locator(".model-library-table tbody tr");
          await expect(libraryRows).toHaveCount(50);
          await expect(page.getByText(`Showing first 50 of ${MODEL_COUNT} models`)).toBeVisible();

          await page.fill(".model-library-search input", "ia-needle");
          await expect(libraryRows).toHaveCount(1);
          await expect(libraryRows.first()).toContainText("ia-needle-model");

          // The page no longer balloons to thousands of pixels.
          const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          expect(pageHeight).toBeLessThan(4500);

          // --- Agents KPIs on mobile: two columns, no truncated values.
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(`${baseUrl}/agents`, { waitUntil: "networkidle" });
          const columns = await page
            .locator(".agents-stat-grid")
            .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
          expect(columns).toBe(2);
          const truncated = await page
            .locator(".agents-stat-grid .stat-card-value")
            .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).length);
          expect(truncated).toBe(0);

          // --- Virtual model dialog: create mode says Create.
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.goto(`${baseUrl}/models?virtualModelDialog=new`, {
            waitUntil: "networkidle",
          });
          await expect(page.locator(".vm-dialog-actions button[type=submit]")).toHaveText("Create");
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
