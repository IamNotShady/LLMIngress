import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("limits page renders KPI cards, the limit-rules table, and the policy note", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/limits`);

    await expect(page.getByRole("heading", { level: 1, name: "Limits" })).toBeVisible();

    // KPI tiles.
    for (const label of [
      "Configured rules",
      "Over-limit today",
      "Near budget",
      "Rate-limit hits 24h",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // The limit-rules table columns.
    const table = page.getByRole("table");
    for (const column of ["Agent", "Budget", "Tokens", "RPM", "TPM", "Concurrency", "Usage"]) {
      await expect(table.getByRole("columnheader", { name: column, exact: true })).toBeVisible();
    }

    // The enforcement-policy callout.
    await expect(page.getByText(/per-rule throttle/i)).toBeVisible();
  });
});
