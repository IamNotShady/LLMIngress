import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("virtual models page renders KPI cards, overview, fallback chart, and editor link", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/models`);

    await expect(
      page.getByRole("heading", { level: 1, name: "Virtual Models / Routes" }),
    ).toBeVisible();

    // KPI tiles.
    for (const label of ["Virtual Models", "今日请求", "本月成本", "平均失败率"]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Overview panel.
    await expect(page.getByRole("heading", { name: "Virtual Model 列表" })).toBeVisible();
    await expect(page.getByText("No virtual models configured.")).toBeVisible();

    // Virtual Model editor entry.
    await expect(page.getByRole("link", { name: "创建 Virtual Model" })).toHaveAttribute(
      "href",
      "/models?virtualModelDialog=new",
    );
  });
});
