import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("pricing route renders the providers model library surface", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/pricing`);

    await expect(page.getByRole("heading", { level: 1, name: "Providers & Models" })).toBeVisible();

    // /pricing is now an alias for the Providers model library surface.
    await expect(page.getByRole("heading", { name: "Model library" })).toBeVisible();
    await expect(page.getByText(/No provider models discovered yet/)).toBeVisible();
  });
});
