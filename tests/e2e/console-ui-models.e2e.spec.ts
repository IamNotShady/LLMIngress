import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("providers route renders the model library surface", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/providers`);

    await expect(page.getByRole("heading", { level: 1, name: "Providers & Models" })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Model library" })).toBeVisible();
    await expect(page.getByText(/No provider models discovered yet/)).toBeVisible();
  });
});

test("routing route redirects to the Virtual Models surface", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/routing`);

    await expect(page).toHaveURL(`${baseUrl}/models`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Virtual Models / Routes" }),
    ).toBeVisible();
  });
});
