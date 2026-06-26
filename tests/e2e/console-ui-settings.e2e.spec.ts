import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("settings page renders only General, Security, and Notification channel settings", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/settings`);

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    // Sub-nav links.
    const subnav = page.getByRole("navigation", { name: "Settings sections" });
    for (const link of ["General", "Security", "Notifications"]) {
      await expect(subnav.getByRole("link", { name: link, exact: true })).toBeVisible();
    }
    for (const removedLink of ["Data", "Danger Zone"]) {
      await expect(subnav.getByRole("link", { name: removedLink, exact: true })).toHaveCount(0);
    }

    // Section headings.
    for (const heading of ["General", "Security", "Notification channels"]) {
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    for (const removedHeading of ["Data", "Danger Zone"]) {
      await expect(page.getByRole("heading", { name: removedHeading, exact: true })).toHaveCount(0);
    }

    await expect(page.getByRole("link", { name: "Export redacted config" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create email notification channel" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Email channel name")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create webhook notification channel" }),
    ).toBeVisible();
  });
});
