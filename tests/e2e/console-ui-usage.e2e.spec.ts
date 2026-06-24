import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("usage & cost page renders reference filters, KPI cards, charts, savings, and summary table", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/usage`);

    await expect(page.getByRole("heading", { level: 1, name: "Usage & Cost" })).toBeVisible();

    for (const label of ["Start date", "End date", "Agent", "Virtual Model", "Provider"]) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }

    // KPI tiles (scoped to stat-card labels — savings is also repeated in the side panel).
    for (const label of [
      "Total cost",
      "Total tokens",
      "Total requests",
      "Avg latency",
      "Failure rate",
      "Estimated savings",
    ]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    for (const title of [
      "Cost trend",
      "Tokens trend",
      "Savings overview",
      "Agent cost distribution",
      "Virtual Model cost distribution",
      "Provider cost distribution",
      "Provider / Model summary",
    ]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }

    const table = page.getByRole("table");
    for (const column of [
      "Provider",
      "Model",
      "Requests",
      "Tokens",
      "Cost",
      "Avg latency",
      "Failure rate",
      "Savings",
    ]) {
      await expect(table.getByRole("columnheader", { name: column })).toBeVisible();
    }
  });
});
