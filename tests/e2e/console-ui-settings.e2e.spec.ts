import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("settings page renders only General, Security, and Notification channel settings", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/settings`);

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    await expect(page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);
    for (const link of ["General", "Security", "Notifications"]) {
      await expect(page.getByRole("link", { name: link, exact: true })).toHaveCount(0);
    }
    for (const removedLink of ["Data", "Danger Zone"]) {
      await expect(page.getByRole("link", { name: removedLink, exact: true })).toHaveCount(0);
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
    const security = page.locator("#settings-security");
    await expect(security).toContainText("Admin password");
    await expect(security).toContainText("Set");
    await expect(security).toContainText("Active sessions");
    await expect(security).toContainText("1");
    await expect(security.getByText("Public access")).toHaveCount(0);
  });
});
