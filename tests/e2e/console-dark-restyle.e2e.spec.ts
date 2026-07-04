import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

// Computed colors authored in OKLCH serialize as "oklch(...)" in Chromium, so
// convert via a 1x1 canvas pixel readback instead of parsing the string.
async function backgroundRgb(
  page: Page,
  locator: Locator | null,
): Promise<[number, number, number]> {
  const color = locator
    ? await locator.evaluate((el) => getComputedStyle(el).backgroundColor)
    : await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  return page.evaluate((value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, color);
}

test("console serves the dark violet Geist skin with compact controls and no overflow", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_dark_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await page.goto(baseUrl);

          // Auth screens already wear the skin: violet primary button, 30px tall.
          const createAdmin = page.getByRole("button", { name: "Create admin" });
          await expect(createAdmin).toBeVisible();
          const [r, g, b] = await backgroundRgb(page, createAdmin);
          expect(b).toBeGreaterThan(150); // violet: blue dominates
          expect(b).toBeGreaterThan(g);
          expect(r).toBeGreaterThan(g);
          const box = await createAdmin.boundingBox();
          expect(box).not.toBeNull();
          expect(Math.round(box?.height ?? 0)).toBe(30);

          await signInFromFirstRun(page, baseUrl);
          await expect(
            page.getByRole("heading", { level: 1, name: "Overview", exact: true }),
          ).toBeVisible();

          // Dark-only document theme, no toggle anywhere.
          expect(
            await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
          ).toBe("dark");
          await expect(page.getByRole("button", { name: /theme/i })).toHaveCount(0);

          // Dark canvas: every channel of the body background is deep.
          const canvas = await backgroundRgb(page, null);
          for (const channel of canvas) {
            expect(channel).toBeLessThan(40);
          }

          // Geist is the rendered UI font.
          const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
          expect(fontFamily).toContain("Geist");

          await page.setViewportSize({ width: 1280, height: 800 });
          const overviewLayout = await page.evaluate(() => {
            const findHeading = (text: string) =>
              Array.from(document.querySelectorAll("h2")).find(
                (heading) => heading.textContent === text,
              );
            const recentCard = findHeading("Recent requests")?.closest(".chart-card");
            if (!recentCard) {
              throw new Error("Recent requests card was not rendered.");
            }

            const recent = recentCard.getBoundingClientRect();
            return {
              recentWidth: recent.width,
            };
          });
          expect(overviewLayout.recentWidth).toBeGreaterThan(900);
          await expect(page.getByRole("heading", { level: 2, name: "Gateway status" })).toHaveCount(
            0,
          );
          const runtimeCard = page.locator(".sidebar-runtime-card");
          await expect(runtimeCard).toContainText("Gateway URL");
          await expect(runtimeCard).toContainText("Uptime");
          await expect(runtimeCard).toContainText("Providers");
          await expect(runtimeCard).not.toContainText(/healthy|unhealthy/i);
          expect(await runtimeCard.locator(".sidebar-provider-health-count").count()).toBe(2);
          const runtimeCardBox = await runtimeCard.boundingBox();
          expect(runtimeCardBox).not.toBeNull();
          expect(runtimeCardBox?.height ?? 0).toBeGreaterThanOrEqual(112);
          await expect(page.locator(".sidebar-account")).toHaveCount(0);
          await expect(page.getByText("Signed in as admin")).toHaveCount(0);
          await expect(page.locator(".topbar-status")).toHaveCount(0);
          await expect(page.locator(".topbar-link")).toHaveCount(0);
          await expect(page.getByText("Help", { exact: true })).toHaveCount(0);

          // No horizontal overflow at desktop and mobile checkpoints.
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            await expect
              .poll(() =>
                page.evaluate(
                  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
                ),
              )
              .toBeLessThanOrEqual(0);
          }
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
