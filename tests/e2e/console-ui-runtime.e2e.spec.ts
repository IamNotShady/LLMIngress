import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("gateway runtime page renders gateway process status without duplicated provider panels", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/runtime`);

    await expect(page.getByRole("heading", { level: 1, name: "Gateway Runtime" })).toBeVisible();

    // Status KPI cards.
    for (const label of [
      "Gateway status",
      "Configured Gateway URL",
      "Config version",
      "Heartbeat",
    ]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }
    await expect(page.getByText("v0.1.0")).toHaveCount(0);

    // Runtime-owned section panels.
    for (const title of ["Gateway internal errors", "Migration status", "Security"]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }

    // Provider health lives on Providers, and observability exports are not actionable here.
    for (const removedTitle of [
      "Provider connectivity",
      "Recent runtime errors",
      "Observability exports",
    ]) {
      await expect(page.getByRole("heading", { name: removedTitle, exact: true })).toHaveCount(0);
    }
    await expect(page.locator(".stat-card-label", { hasText: /^Prometheus Metrics$/ })).toHaveCount(
      0,
    );
  });
});
