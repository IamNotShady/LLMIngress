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

test("console serves the light-default token skin in both themes with no overflow", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_skin_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

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

        // The auth panel already wears the skin: a shadowless hairline card on
        // the page background, with a full-width primary button.
        const createAdmin = page.getByRole("button", { name: "Create admin" });
        await expect(createAdmin).toBeVisible();
        expect(await createAdmin.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
        expect(Math.round((await createAdmin.boundingBox())?.height ?? 0)).toBe(40);

        await signInFromFirstRun(page, baseUrl);
        await expect(
          page.getByRole("heading", { level: 1, name: "Overview", exact: true }),
        ).toBeVisible();

        // Light is the default here (the test browser reports no dark
        // preference) and the canvas is the pure white the tokens declare.
        await expect
          .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
          .toBe("light");
        const lightCanvas = await backgroundRgb(page, null);
        for (const channel of lightCanvas) {
          expect(channel).toBe(255);
        }

        // The module row is text in the ink and dim tokens. An anchor with no
        // colour of its own falls through to the stylesheet's link colour,
        // which turned the whole masthead accent-blue.
        const nav = page.getByRole("navigation", { name: "Console modules" });
        const inkRgb = await backgroundRgb(page, null).then(() =>
          page.evaluate(() => {
            const probe = document.createElement("span");
            probe.className = "text-ink";
            document.body.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          }),
        );
        const accentRgb = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--accent)";
          document.body.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        });
        const activeColor = await nav
          .getByRole("link", { name: "Overview", exact: true })
          .evaluate((el) => getComputedStyle(el).color);
        expect(activeColor).toBe(inkRgb);
        for (const label of ["Providers", "Usage"]) {
          const color = await nav
            .getByRole("link", { name: label, exact: true })
            .evaluate((el) => getComputedStyle(el).color);
          expect(color, label).not.toBe(accentRgb);
          expect(color, label).not.toBe(activeColor);
        }

        // Open Sans is the rendered UI font; DM Mono carries the data.
        expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
          "Open Sans",
        );
        const dataCell = page.getByText(/^gw · /);
        expect(await dataCell.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
          "DM Mono",
        );
        // DM Mono ships nothing above 500; a heavier request would be faked.
        const monoWeights = await page.evaluate(() =>
          Array.from(document.querySelectorAll("*"))
            .filter((el) => getComputedStyle(el).fontFamily.includes("DM Mono"))
            .map((el) => Number.parseInt(getComputedStyle(el).fontWeight, 10)),
        );
        expect(Math.max(...monoWeights)).toBeLessThanOrEqual(500);

        // The toggle switches the whole document, not one component.
        await page.getByRole("button", { name: "Switch to dark theme" }).click();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
          .toBe("dark");
        const darkCanvas = await backgroundRgb(page, null);
        for (const channel of darkCanvas) {
          expect(channel).toBeLessThan(40);
        }

        // No horizontal overflow at the desktop target or below it, in either
        // theme — wide bands scroll inside themselves instead.
        for (const theme of ["dark", "light"]) {
          if (theme === "light") {
            await page.getByRole("button", { name: "Switch to light theme" }).click();
          }
          for (const viewport of [
            { width: 1440, height: 900 },
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
        }
      } finally {
        await context.close();
      }
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await fixture.dispose();
  }
});
