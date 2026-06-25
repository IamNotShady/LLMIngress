import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("settings page renders the sub-nav and General / Data / Notifications / Danger Zone sections", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/settings`);

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    // Sub-nav links.
    const subnav = page.getByRole("navigation", { name: "Settings sections" });
    for (const link of ["General", "Security", "Data", "Notifications", "Danger Zone"]) {
      await expect(subnav.getByRole("link", { name: link, exact: true })).toBeVisible();
    }

    // Section headings.
    for (const heading of ["General", "Security", "Data", "Notification channels", "Danger Zone"]) {
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    // The redacted config export remains available.
    await expect(page.getByRole("link", { name: "Export redacted config" })).toBeVisible();
  });
});
