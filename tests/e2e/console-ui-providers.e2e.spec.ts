import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("providers page renders KPI cards, the provider overview, and management controls", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/providers`);

    await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();

    // KPI tiles.
    for (const label of ["Providers", "Enabled", "Models", "Healthy"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Overview panel + management area.
    await expect(page.getByRole("heading", { name: "Provider list" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Manage providers" })).toBeVisible();

    // Existing management controls are preserved.
    await expect(page.getByText("New provider", { exact: true })).toBeVisible();
    await expect(page.getByText("Add from template", { exact: true })).toBeVisible();
  });
});
