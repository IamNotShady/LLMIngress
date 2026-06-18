import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("gateway runtime page renders status cards, connectivity, errors, exports, and security", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/runtime`);

    await expect(page.getByRole("heading", { level: 1, name: "Gateway Runtime" })).toBeVisible();

    // Status KPI cards.
    for (const label of ["Gateway status", "Runtime address", "Version", "Heartbeat"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Section panels.
    for (const title of [
      "Provider connectivity",
      "Recent runtime errors",
      "Observability exports",
      "Migration status",
      "Security",
    ]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }

    // An observability export entry.
    await expect(
      page.locator(".stat-card-label", { hasText: /^Prometheus Metrics$/ }),
    ).toBeVisible();
  });
});
