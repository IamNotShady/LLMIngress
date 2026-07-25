import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

const gatewayUrl = "http://127.0.0.1:4000";

async function pageOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// Both views must present the same blocks: what the key is configured for and
// how to point an agent at it. Returns the configuration text and the first
// guide's text so the two can be compared without hard-coding any formatting.
async function readSharedBlocks(scope: Locator | Page): Promise<{
  configuration: string;
  guide: string;
  platforms: string[];
}> {
  await expect(scope.getByText("CONFIGURATION", { exact: true })).toBeVisible();
  await expect(scope.getByText(/^set up your agent$/i)).toBeVisible();

  const configuration = await scope
    .locator("dl, [data-testid='api-key-configuration']")
    .first()
    .innerText();
  const platforms = await scope.locator("[data-guide-tab]").allInnerTexts();
  const guide = await scope.locator("[data-guide-panel]:visible").first().innerText();
  return { configuration: configuration.trim(), guide: guide.trim(), platforms };
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await pageOverflowPx(page), `${label} @ ${viewport.width}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test("API key created and detail dialogs share one layout and differ only in the key field", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_api_key_parity_e2e_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const routedVmId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      await client.query(
        `insert into virtual_models (id, name, description, enabled)
         values ($1, 'parity-vm', 'Parity VM', true)`,
        [routedVmId],
      );
      await client.query(
        `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
         values ($1, $2, 'fixed', 'messages')`,
        [randomUUID(), routedVmId],
      );
    });

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_URL: gatewayUrl },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();

      try {
        await waitForConsole(baseUrl, consoleApp);
        await page.setViewportSize({ width: 1280, height: 800 });
        await signInFromFirstRun(page, baseUrl);

        // --- Create -----------------------------------------------------
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });
        await page.getByRole("link", { name: "Grant parity-vm" }).click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await page.getByLabel("API key name").fill("parity-key");
        await page.getByRole("button", { name: "Create key" }).click();

        // --- The one-time screen is the only place the plaintext exists.
        await expect(page.getByText("SECRET · SHOWN ONCE")).toBeVisible();
        const plaintext = await page.getByLabel("API key secret").inputValue();
        expect(plaintext.startsWith("llmi_")).toBe(true);
        await expect(page.getByText("parity-vm").first()).toBeVisible();
        await expect(page.getByText(`${gatewayUrl}`).first()).toBeVisible();
        await expect(page.getByText("Stored hashed")).toBeVisible();
        const created = await readSharedBlocks(page);
        await expectNoOverflow(page, "created page");

        // --- The detail states the same configuration, with the prefix only.
        await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
        await page
          .getByRole("link", { name: /parity-key/ })
          .first()
          .click();
        await page.waitForLoadState("networkidle");
        await expect(page.getByText("Virtual Model access")).toBeVisible();
        await expect(page.getByText("parity-vm").first()).toBeVisible();

        const detail = await readSharedBlocks(page);
        expect(detail.platforms).toEqual(created.platforms);
        expect(detail.configuration).toBe(created.configuration);
        // The guide is the same set-up, with the secret replaced by a
        // placeholder — it was shown once and is stored hashed.
        expect(detail.guide).toBe(created.guide.replaceAll(plaintext, "<YOUR_API_KEY>"));
        await expectNoOverflow(page, "detail dialog");

        const shownPrefix = await page
          .getByText(/^llmi_/)
          .first()
          .innerText();
        expect(plaintext.startsWith(shownPrefix.replace(/…$/, ""))).toBe(true);
        expect(shownPrefix.length).toBeLessThan(plaintext.length);
        // Nothing on this page can reveal the rest of it.
        await expect(page.getByText(plaintext)).toHaveCount(0);
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
