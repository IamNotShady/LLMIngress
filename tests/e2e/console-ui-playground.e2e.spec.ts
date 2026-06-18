import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("playground page renders the two-column request config and response preview", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/playground`);

    await expect(page.getByRole("heading", { level: 1, name: "Playground" })).toBeVisible();

    // Left request-config panel.
    await expect(page.getByRole("heading", { name: "Request config" })).toBeVisible();
    await expect(page.getByLabel("Agent API key")).toBeVisible();
    await expect(page.getByLabel("Gateway base URL")).toBeVisible();
    await expect(page.getByLabel("Playground prompt")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send live request" })).toBeVisible();

    // Right response-preview panel.
    await expect(page.getByRole("heading", { name: "Response preview" })).toBeVisible();
    await expect(page.getByText(/key stays in your browser/i)).toBeVisible();
  });
});
