import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { consoleNavItems } from "../../apps/console/src/app/_ui/nav";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

test("the masthead routes each module to its own page and follows the chosen theme", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_sidebar_${randomUUID().replaceAll("-", "_")}`,
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
        await signInFromFirstRun(page, baseUrl);

        const nav = page.getByRole("navigation", { name: "Console modules" });
        await expect(nav).toBeVisible();

        // Each module owns its view choices. Leaving and returning through the
        // masthead restores them instead of rebuilding the module defaults.
        await page.getByRole("link", { name: "7d", exact: true }).click();
        await page.getByRole("link", { name: "Hide", exact: true }).click();
        await expect(nav.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute(
          "href",
          "/?window=7d&setup=closed",
        );
        await nav.getByRole("link", { name: "Usage", exact: true }).click();
        await page.getByRole("link", { name: "30d", exact: true }).click();
        await expect(nav.getByRole("link", { name: "Usage", exact: true })).toHaveAttribute(
          "href",
          "/usage?window=30d",
        );
        await nav.getByRole("link", { name: "Overview", exact: true }).click();
        await expect(page).toHaveURL(`${baseUrl}/?window=7d&setup=closed`);
        await expect(page.getByRole("link", { name: "7d", exact: true })).toHaveClass(/bg-seg/);
        await expect(page.getByRole("link", { name: "Show", exact: true })).toBeVisible();

        // One row, eight modules, each rendering only its own page.
        for (const item of consoleNavItems) {
          await nav.getByRole("link", { name: item.label, exact: true }).click();
          await page.waitForURL((url) => url.pathname === item.href);
          await expect(
            page.getByRole("heading", { level: 1, name: item.label, exact: true }),
          ).toBeVisible();
          // The active item is marked for assistive tech.
          await expect(nav.getByRole("link", { name: item.label, exact: true })).toHaveAttribute(
            "aria-current",
            "page",
          );
        }

        // The theme is a stated choice, not a hardcoded skin: light by default
        // here (the test browser reports no dark preference) and switchable.
        expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
          "light",
        );
        await page.getByRole("button", { name: "Switch to dark theme" }).click();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
          .toBe("dark");
        // The choice survives a reload rather than reverting to the default.
        await page.reload();
        expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
          "dark",
        );
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
