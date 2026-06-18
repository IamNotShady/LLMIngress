import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("overview dashboard renders KPI cards, recent requests, gateway status, and charts", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(baseUrl);

    // Page heading.
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

    // The six KPI metric tiles.
    for (const label of [
      "Requests today",
      "Cost today",
      "Tokens today",
      "Failure rate",
      "Savings",
      "Online agents",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // The dashboard panels and charts.
    await expect(page.getByRole("heading", { name: "Recent requests" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gateway status" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Requests & cost trend" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Top agents" })).toBeVisible();
  });
});
