import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
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

test("empty dashboard views render the shared EmptyState with no overflow", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_empty_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
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
        await page.goto(`${baseUrl}/providers`);
        await expect(page.getByRole("heading", { name: "No providers yet" })).toBeVisible();
        // The empty state says what a provider is for and offers the way in.
        await expect(page.getByText("A provider is where requests actually go")).toBeVisible();
        await expect(page.getByRole("link", { name: "+ Add Provider" }).first()).toBeVisible();

        await page.goto(`${baseUrl}/models`);
        await expect(page.getByRole("heading", { name: "No virtual models yet" })).toBeVisible();
        await page.goto(`${baseUrl}/api-keys`);
        await expect(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
        await page.goto(`${baseUrl}/activity`);
        await expect(page.getByRole("heading", { name: "No requests yet" })).toBeVisible();

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
