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

test("playground shows the shared Spinner while models load, with no overflow", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_spinner_${randomUUID().replaceAll("-", "_")}`,
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
        await page.goto(`${baseUrl}/playground`);
        // Delay the allowed-models request so the loading spinner stays observable.
        await page.route("**/v1/models**", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: [] }),
          });
        });
        await page.getByLabel("API key", { exact: true }).fill("llmi_pg_e2e_spinner_key");
        // Which models a key may call is the gateway's answer, and the wait for
        // it is stated rather than left looking like an empty list.
        await expect(page.getByRole("status", { name: "Loading models" })).toBeVisible();
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
