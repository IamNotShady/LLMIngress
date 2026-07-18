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

// A provider plus one enabled API key so the key row exposes the enable/disable
// toggle (a toast-mode, refresh-path mutation). The toggle only flips `enabled`,
// so a placeholder encrypted_key object is sufficient.
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

test("a refresh-path mutation surfaces a success toast, with no overflow", async ({ browser }) => {
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
        await page.goto(`${baseUrl}/providers?selected=${providerId}`);
        await page.getByRole("button", { name: "Disable API key" }).click();
        const toast = page.locator(".console-mutation-toast--success");
        await expect(toast).toBeVisible();
        await expect(toast).toContainText("Provider API key updated");
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
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
