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

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// A provider plus one enabled connection, so the connection row offers Re-check
// — an idempotent action, which is the only kind that reports through a toast.
// The probe only reads the stored credential, so a placeholder object is enough.
async function seedProviderWithKey(databaseUrl: string): Promise<string> {
  const providerId = randomUUID();
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, enabled)
       values ($1, 'api_key', 'toast-seed-provider', 'Toast Seed Provider', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, enabled)
       values ($1, $2, 'llmi_seed', '{"v":1}'::jsonb, $3, true)`,
      [randomUUID(), providerId, `seed-key-${randomUUID()}`],
    );
  });
  return providerId;
}

test("an idempotent action reports through a toast that clears itself", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_toast_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = await seedProviderWithKey(fixture.databaseUrl);
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
        await page.setViewportSize({ width: 1280, height: 800 });
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/providers?selected=${providerId}&modelPageSize=50`);
        const before = page.url();

        await page.getByRole("button", { name: "Re-check" }).first().click();
        const toast = page.getByRole("status");
        await expect(toast).toBeVisible();
        // Reporting is not navigating: the selection, the filters and the
        // scroll position the operator left behind are all still theirs.
        expect(page.url()).toBe(before);
        await expect(toast).toContainText("Connection re-check queued");
        // It says what did and did not happen: a queued probe is not a result,
        // and nothing about the stored credential changed.
        await expect(toast).toContainText("nothing about the credential changed");

        // It sits out of the way, bottom-right, above the page.
        const box = await toast.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            position: getComputedStyle(element).position,
            right: rect.right,
          };
        });
        expect(box.position).toBe("fixed");
        expect(box.right).toBeLessThanOrEqual(1280);
        expect(box.bottom).toBeLessThanOrEqual(800);

        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
        }
        await page.setViewportSize({ width: 1280, height: 800 });

        // Nobody has to dismiss it: it clears itself after four seconds.
        await expect(toast).toBeHidden({ timeout: 8_000 });
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
