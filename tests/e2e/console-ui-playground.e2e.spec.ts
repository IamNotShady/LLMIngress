import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("playground page renders the reference request and result workspace", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/playground`);
    const playgroundSection = page.getByLabel("Playground");

    await expect(page.getByRole("heading", { level: 1, name: "Playground" })).toBeVisible();
    await expect(
      page.getByText("Test live requests through the Gateway Public API."),
    ).toBeVisible();

    await expect(
      playgroundSection.getByRole("heading", { name: "Request configuration" }),
    ).toBeVisible();
    await expect(playgroundSection.getByLabel(/Agent API Key/)).toBeVisible();
    await expect(playgroundSection.getByLabel(/Endpoint/)).toHaveValue("chat_completions");
    await expect(playgroundSection.getByLabel(/Virtual Model/)).toBeVisible();
    await expect(playgroundSection.getByLabel(/Prompt$/)).toBeVisible();
    await expect(playgroundSection.getByLabel(/System Prompt/)).toBeVisible();
    await expect(playgroundSection.getByLabel("Temperature")).toHaveValue("0.7");
    await expect(playgroundSection.getByLabel("Top P")).toHaveValue("0.9");
    await expect(playgroundSection.getByLabel("Max Tokens")).toHaveValue("1024");
    await expect(playgroundSection.getByLabel("Stream")).toHaveValue("off");
    await expect(playgroundSection.getByLabel("Stream")).toContainText("On");
    await expect(playgroundSection.getByRole("button", { name: "Send test" })).toBeVisible();
    await expect(playgroundSection.getByRole("button", { name: "Clear" })).toBeVisible();

    await expect(
      playgroundSection.getByRole("heading", { name: "Response preview" }),
    ).toBeVisible();
    await expect(
      playgroundSection.getByRole("heading", { name: "Request and routing details" }),
    ).toBeVisible();
    await expect(
      playgroundSection.getByRole("heading", { name: "Comparison results (optional)" }),
    ).toHaveCount(0);
    await expect(playgroundSection.getByText("No comparison results.")).toHaveCount(0);
    await expect(page.getByText(/Agent API Key stays in browser memory only/)).toBeVisible();

    await expect(playgroundSection.getByLabel("Gateway base URL")).toHaveCount(0);
    await expect(
      playgroundSection.getByRole("button", { name: "Load allowed models" }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
  });
});
