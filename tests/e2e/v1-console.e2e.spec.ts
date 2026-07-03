import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { consoleNavItems } from "../../apps/console/src/app/_lib/nav";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

test("sidebar groups modules and routes each nav item to its own page with a theme toggle", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_sidebar_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

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

          const sidebar = page.getByRole("navigation", { name: "Console sections" });
          await expect(sidebar).toBeVisible();

          // The redesigned sidebar is a flat icon-chip list (no group headers).
          // Each module is reachable from the sidebar and renders only its own page.
          for (const item of consoleNavItems) {
            await sidebar.getByRole("link", { name: item.label, exact: true }).click();
            const expectedPath = item.href === "/" ? "/" : item.href;
            const expectedHeading = item.pageTitle ?? item.label;
            await page.waitForURL((url) => url.pathname === expectedPath);
            await expect(
              page.getByRole("heading", { level: 1, name: expectedHeading, exact: true }),
            ).toBeVisible();
            // The active item is marked for assistive tech.
            await expect(
              sidebar.getByRole("link", { name: item.label, exact: true }),
            ).toHaveAttribute("aria-current", "page");
          }

          // Theme toggle flips the document theme between light and dark.
          const themeBefore = await page.evaluate(() =>
            document.documentElement.getAttribute("data-theme"),
          );
          await page.getByRole("button", { name: /theme/i }).click();
          await expect
            .poll(async () =>
              page.evaluate(() => document.documentElement.getAttribute("data-theme")),
            )
            .not.toBe(themeBefore);
          const themeAfter = await page.evaluate(() =>
            document.documentElement.getAttribute("data-theme"),
          );
          expect(["light", "dark"]).toContain(themeAfter);
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
