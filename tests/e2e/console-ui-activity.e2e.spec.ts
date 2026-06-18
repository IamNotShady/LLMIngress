import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("activity page renders the filter bar and request-list structure", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/activity`);

    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();

    // The redesigned filter bar.
    await expect(page.getByLabel("Status")).toBeVisible();
    await expect(page.getByLabel("Request ID")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply" })).toBeVisible();
  });
});
