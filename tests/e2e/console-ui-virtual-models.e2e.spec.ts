import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("virtual models page renders KPI cards, overview, fallback chart, and editor link", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/models`);

    await expect(page.getByRole("heading", { level: 1, name: "Virtual Models" })).toBeVisible();

    // KPI tiles.
    for (const label of ["Virtual Models", "With routes", "Requests today", "Avg failure rate"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Overview + fallback panels.
    await expect(page.getByRole("heading", { name: "Virtual Model list" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fallback overview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Manage virtual models" })).toBeVisible();

    // Route policy editor link.
    await expect(page.getByRole("link", { name: "route policy editor" })).toHaveAttribute(
      "href",
      "/routing",
    );
  });
});
