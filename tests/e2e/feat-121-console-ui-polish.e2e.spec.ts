import { expect, type Page, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";
import { openDisclosure } from "../support/console-ui";

const POLISH_AGENT_ID = "00000000-0000-4000-8000-000000000921";

test("console UI polish themes overlays and preserves layout", async ({ browser }) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/providers`, { waitUntil: "domcontentloaded" });
      await openDisclosure(page, "New provider");
      await expect(page.getByRole("dialog", { name: "Add Provider" })).toBeVisible();

      const overlay = await page.evaluate(() => {
        const dialog = document.querySelector(".console-dialog");
        const scrim = document.querySelector(".console-dialog-scrim");
        if (!(dialog instanceof HTMLElement) || !(scrim instanceof HTMLElement)) {
          throw new Error("Expected rendered dialog and scrim.");
        }
        const dialogStyle = getComputedStyle(dialog);
        const scrimStyle = getComputedStyle(scrim);
        return {
          dialogAnimation: dialogStyle.animationName,
          scrimBackdrop:
            scrimStyle.backdropFilter ||
            (scrimStyle as CSSStyleDeclaration & { webkitBackdropFilter?: string })
              .webkitBackdropFilter ||
            "",
        };
      });
      expect(overlay.dialogAnimation).toBe("dialog-in");
      expect(overlay.scrimBackdrop).toContain("blur");

      await page.evaluate(() => localStorage.setItem("llmingress-theme", "light"));
      await page.goto(`${baseUrl}/agents?deleteAgent=${POLISH_AGENT_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("dialog", { name: "Delete Polish Agent?" })).toBeVisible();
      const lightDanger = await readBackgroundColor(page, ".agent-delete-confirm");
      await page.evaluate(() => localStorage.setItem("llmingress-theme", "dark"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("dialog", { name: "Delete Polish Agent?" })).toBeVisible();
      const darkDanger = await readBackgroundColor(page, ".agent-delete-confirm");
      expect(darkDanger).not.toBe(lightDanger);

      for (const viewport of [
        { height: 720, width: 1280 },
        { height: 844, width: 390 },
      ]) {
        await page.setViewportSize(viewport);
        for (const path of ["/", "/providers", "/activity", "/limits"]) {
          await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
          const scrollWidth = await readDocumentScrollWidth(page);
          if (scrollWidth > viewport.width) {
            throw new Error(
              `${path} at ${viewport.width}px has scrollWidth ${scrollWidth}: ${JSON.stringify(
                await readOverflowElements(page, viewport.width),
              )}`,
            );
          }
        }
      }

      await page.setViewportSize({ height: 720, width: 1280 });
      await page.goto(`${baseUrl}/models?virtualModelDialog=new`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("dialog", { name: "Create Virtual Model" })).toBeVisible();
      await page.waitForTimeout(200);
      const before = await readSecondOptionCardRect(page);
      await page.locator(".option-card").first().hover();
      const after = await readSecondOptionCardRect(page);
      expectStableRect(after, before);
    },
    { seed: seedPolishAgent },
  );
});

async function readBackgroundColor(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function readDocumentScrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

async function readOverflowElements(page: Page, viewportWidth: number) {
  return page.evaluate((width) => {
    return Array.from(document.querySelectorAll("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className:
            typeof (element as HTMLElement).className === "string"
              ? (element as HTMLElement).className
              : "",
          rectRight: Math.round(rect.right),
          tagName: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").trim().slice(0, 40),
        };
      })
      .filter((item) => item.rectRight > width)
      .slice(0, 8);
  }, viewportWidth);
}

type Rect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

async function readSecondOptionCardRect(page: Page): Promise<Rect> {
  return page
    .locator(".option-card")
    .nth(1)
    .evaluate((element) => {
      const box = element as HTMLElement;
      return {
        height: box.offsetHeight,
        width: box.offsetWidth,
        x: box.offsetLeft,
        y: box.offsetTop,
      };
    });
}

function expectStableRect(actual: Rect, expected: Rect) {
  for (const key of ["height", "width", "x", "y"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `option-card sibling ${key}`).toBeLessThanOrEqual(
      1,
    );
  }
}

async function seedPolishAgent(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
        values ($1, 'Polish Agent', 'coding', 'llmi_polish', 'hash-polish-agent', true)
      `,
      [POLISH_AGENT_ID],
    );
  } finally {
    await client.end();
  }
}
