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

// Both views hand over the same setup: the same platforms, and the same
// snippets for the one on screen. Returns them without hard-coding formatting,
// so the comparison survives a restyle of either side.
async function readSharedGuide(scope: Locator | Page): Promise<{
  platforms: string[];
  snippets: string[];
  steps: string;
}> {
  const platforms = await scope.locator("[data-guide-tab]").allInnerTexts();
  const panel = scope.locator("[data-guide-panel]:visible").first();
  const snippets = await panel.locator("pre").allInnerTexts();
  const steps = await panel.locator("ol").first().innerText();
  return { platforms, snippets: snippets.map((entry) => entry.trim()), steps: steps.trim() };
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
        await expect(page.getByText("CONFIGURATION", { exact: true })).toBeVisible();
        const created = await readSharedGuide(page);
        await expectNoOverflow(page, "created page");

        // --- The key's own dialog hands over the same setup, with the prefix.
        await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
        await page
          .getByRole("link", { name: /parity-key/ })
          .first()
          .click();
        await page.waitForLoadState("networkidle");
        await expect(page.getByText("Virtual Model access")).toBeVisible();
        await expect(page.getByText("parity-vm").first()).toBeVisible();

        // The detail's own prefix cell: the list row beside it now reads
        // "llmi_… · 1 model", which is a different string about the same key.
        const shownPrefix = await page
          .getByText(/^llmi_\S+$/)
          .first()
          .innerText();

        await page.getByRole("link", { name: "Set up an agent" }).click();
        const setup = page.getByRole("dialog", { name: "Set up an agent" });
        // No grant was starred, so the dialog says so and falls back to the one
        // model the key does have — the same one the created page named.
        await expect(setup).toContainText("parity-key");
        await expect(setup).toContainText("default model none");
        const detail = await readSharedGuide(setup);
        expect(detail.platforms).toEqual(created.platforms);
        expect(detail.steps).toBe(created.steps);
        // The same snippets, with a placeholder standing in for the secret that
        // was shown once and is stored hashed. Not the prefix: that would make a
        // complete-looking line carrying a truncated key, beside a Copy button,
        // and it would fail as a wrong secret rather than as a blank.
        expect(detail.snippets).toEqual(
          created.snippets.map((snippet) => snippet.replaceAll(plaintext, "<YOUR_API_KEY>")),
        );
        expect(detail.snippets.join("\n")).not.toContain(shownPrefix.replace(/…$/, ""));
        await expectNoOverflow(page, "setup dialog");

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
