import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("playground page renders the reference request and result workspace", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/playground`);
    const playgroundSection = page.getByLabel("Playground");

    await expect(page.getByRole("heading", { level: 1, name: "Playground" })).toBeVisible();
    await expect(page.getByText("通过 Gateway Public API 进行实时测试")).toBeVisible();

    await expect(playgroundSection.getByRole("heading", { name: "请求配置" })).toBeVisible();
    await expect(playgroundSection.getByLabel(/Agent API Key/)).toBeVisible();
    await expect(playgroundSection.getByLabel(/Endpoint/)).toHaveValue("chat_completions");
    await expect(playgroundSection.getByLabel(/Virtual Model/)).toBeVisible();
    await expect(playgroundSection.getByLabel(/Prompt$/)).toBeVisible();
    await expect(playgroundSection.getByLabel(/System Prompt/)).toBeVisible();
    await expect(playgroundSection.getByLabel("Temperature")).toHaveValue("0.7");
    await expect(playgroundSection.getByLabel("Top P")).toHaveValue("0.9");
    await expect(playgroundSection.getByLabel("Max Tokens")).toHaveValue("1024");
    await expect(playgroundSection.getByLabel("Stream")).toHaveValue("off");
    await expect(playgroundSection.getByLabel("Stream")).toContainText("开启");
    await expect(playgroundSection.getByRole("button", { name: "发送测试" })).toBeVisible();
    await expect(playgroundSection.getByRole("button", { name: "清空" })).toBeVisible();

    await expect(playgroundSection.getByRole("heading", { name: "响应预览" })).toBeVisible();
    await expect(playgroundSection.getByRole("heading", { name: "请求与路由详情" })).toBeVisible();
    await expect(playgroundSection.getByRole("heading", { name: "对比结果（可选）" })).toHaveCount(
      0,
    );
    await expect(playgroundSection.getByText("暂无对比结果。")).toHaveCount(0);
    await expect(playgroundSection.getByText(/Agent API Key 只保存在浏览器内存中/)).toBeVisible();

    await expect(playgroundSection.getByLabel("Gateway base URL")).toHaveCount(0);
    await expect(
      playgroundSection.getByRole("button", { name: "Load allowed models" }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
  });
});
