import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("agents page renders KPI cards, the agent overview, and management controls", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/agents`);

    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();

    // KPI tiles.
    for (const label of ["Agents", "Connected", "Requests today", "Cost this week"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Overview panel + management area.
    await expect(page.getByRole("heading", { name: "Agent list" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Manage agents" })).toBeVisible();

    // Existing management control is preserved.
    await expect(page.getByText("New agent", { exact: true })).toBeVisible();
  });
});
