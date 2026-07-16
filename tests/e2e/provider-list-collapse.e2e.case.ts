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

async function seedCollapseData(databaseUrl: string) {
  const alphaId = randomUUID();
  const betaId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, enabled)
       values ($1, 'api_key', 'collapse-alpha', 'Collapse Alpha', true),
              ($2, 'api_key', 'collapse-beta', 'Collapse Beta', true)`,
      [alphaId, betaId],
    );
    await client.query(
      `insert into provider_models (id, provider_id, model_id, display_name)
       values ($1, $2, 'collapse-alpha-model', 'Collapse Alpha Model'),
              ($3, $4, 'collapse-beta-model', 'Collapse Beta Model')`,
      [randomUUID(), alphaId, randomUUID(), betaId],
    );
  });

  return { alphaId, betaId };
}

test("provider list defaults to fully collapsed and rows toggle open and closed", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_collapse_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedCollapseData(fixture.databaseUrl);
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

        // Default state: fully collapsed, model library spans every provider.
        await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
        await expect(page.locator(".provider-inline-detail-row")).toHaveCount(0);
        await expect(
          page.locator('.providers-table a.table-row-link[aria-expanded="true"]'),
        ).toHaveCount(0);
        const libraryRows = page.locator(".model-library-table tbody tr");
        await expect(libraryRows.filter({ hasText: "Collapse Alpha" })).toHaveCount(1);
        await expect(libraryRows.filter({ hasText: "Collapse Beta" })).toHaveCount(1);

        // Clicking a collapsed row expands it and scopes the model library.
        await page
          .locator(".providers-table a.table-row-link", { hasText: "Collapse Alpha" })
          .first()
          .click();
        await expect(page).toHaveURL(`${baseUrl}/providers?selected=${seeded.alphaId}`);
        await expect(page.locator(".provider-inline-detail-row")).toHaveCount(1);
        await expect(libraryRows.filter({ hasText: "Collapse Beta" })).toHaveCount(0);

        // Clicking the expanded row again collapses everything.
        await page.locator(".providers-table tr.is-selected a.table-row-link").first().click();
        await expect(page.locator(".provider-inline-detail-row")).toHaveCount(0);
        expect(new URL(page.url()).searchParams.get("selected")).toBeNull();
        await expect(libraryRows.filter({ hasText: "Collapse Beta" })).toHaveCount(1);

        // Collapsed search spans providers and stays collapsed.
        await page.locator("#provider-model-query").fill("collapse-beta");
        await page.locator("#provider-model-query").press("Enter");
        await expect(libraryRows).toHaveCount(1);
        await expect(libraryRows.first()).toContainText("Collapse Beta Model");
        expect(new URL(page.url()).searchParams.get("selected")).toBeNull();

        // No horizontal overflow at 1280 and 390 in the collapsed state.
        await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${viewport.width}px viewport`).toBeLessThanOrEqual(0);
        }
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
