import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("usage & cost page renders the window filter, KPI cards, charts, and summary table", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/usage`);

    await expect(page.getByRole("heading", { level: 1, name: "Usage & Cost" })).toBeVisible();

    // Window filter.
    await expect(page.getByLabel("Window")).toBeVisible();

    // KPI tiles (scoped to stat-card labels — "Savings" is also a panel heading).
    for (const label of [
      "Total cost",
      "Total tokens",
      "Total requests",
      "Avg latency",
      "Failure rate",
      "Savings",
    ]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Trend + breakdown chart panels.
    for (const title of [
      "Cost trend",
      "Tokens trend",
      "Agent cost",
      "Virtual Model cost",
      "Provider cost",
      "Provider / Model summary",
      "Savings",
    ]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }
  });
});
