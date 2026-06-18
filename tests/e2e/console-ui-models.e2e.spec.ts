import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("models page renders KPI cards and the provider model directory table", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/pricing`);

    await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();

    // KPI tiles.
    for (const label of ["Models", "Providers", "Priced models"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Directory panel (empty-state on a fresh install — no providers seeded).
    await expect(page.getByRole("heading", { name: "Model directory" })).toBeVisible();
    await expect(page.getByText(/No provider models discovered yet/)).toBeVisible();
  });
});
