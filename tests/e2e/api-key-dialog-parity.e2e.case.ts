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

// Both dialogs must present the same blocks in the same shell. Returns the
// Budget section text so the two dialogs can be compared against each other
// without hard-coding the console's number formatting.
async function expectSharedDetailLayout(dialog: Locator): Promise<string> {
  await expect(dialog).toHaveClass(/api-key-view-dialog/);
  await expect(dialog.locator(".api-key-view-column")).toHaveCount(2);
  await expect(dialog.getByRole("heading", { name: "Budget / Limit" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Endpoints" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Integration guide" })).toBeVisible();
  await expect(dialog.locator("dt").filter({ hasText: "Created" })).toHaveCount(1);
  await expect(dialog.locator("dt").filter({ hasText: "Enabled" })).toHaveCount(1);
  await expect(dialog.locator("dt").filter({ hasText: "Default model" })).toHaveCount(1);
  await expect(dialog.getByRole("tab")).toHaveCount(8);

  const budget = dialog.locator(".api-key-detail-section", { hasText: "Budget / Limit" });
  // The limits were saved with the key, so nothing may render as unconfigured.
  await expect(budget).not.toContainText("Not configured");
  return (await budget.innerText()).trim();
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
        await page.goto(`${baseUrl}/api-keys?apiKeyDialog=new`);
        await expect(page.getByLabel("Name")).toBeVisible();
        await page.getByLabel("Name").fill("parity-key");
        await page.getByLabel("parity-vm").check();
        await page.getByLabel("Enable limits").check();
        await page.getByRole("button", { name: "Create" }).click();

        const created = page.getByRole("dialog", { name: "API Key created" });
        await expect(created).toBeVisible();
        const createdBudget = await expectSharedDetailLayout(created);
        await expect(created).toContainText(`${gatewayUrl}/v1/messages`);
        await expect(created).toContainText("parity-vm");

        // The plaintext key is shown outright.
        const createdField = created.getByRole("textbox", { name: "API key" });
        const plaintext = await createdField.inputValue();
        expect(plaintext.startsWith("llmi_")).toBe(true);

        // The eye masks it without losing the real value, and toggles back.
        await created.getByRole("button", { name: "Hide API key" }).click();
        const masked = await createdField.inputValue();
        expect(masked).not.toContain("llmi_");
        expect(masked).toMatch(/^•+$/);
        await created.getByRole("button", { name: "Copy API key" }).click();
        // The title only flips once writeText resolves, so waiting on it first
        // keeps the clipboard read from racing the copy.
        await expect(created.getByRole("button", { name: "Copy API key" })).toHaveAttribute(
          "title",
          "Copied",
        );
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(plaintext);
        await created.getByRole("button", { name: "Show API key" }).click();
        expect(await createdField.inputValue()).toBe(plaintext);

        await expectNoOverflow(page, "created dialog");
        await created.getByRole("link", { name: "Close" }).click();

        // --- Detail -----------------------------------------------------
        // The list row is a plain anchor, so this is a full navigation. The
        // dialog paints before React hydrates, so wait for the load to settle
        // or the interaction assertions below land on a dead dialog.
        await page.getByRole("link", { name: "parity-key", exact: true }).first().click();
        await page.waitForLoadState("networkidle");
        const detail = page.getByRole("dialog", { name: "parity-key" });
        await expect(detail).toBeVisible();
        const detailBudget = await expectSharedDetailLayout(detail);
        await expect(detail).toContainText(`${gatewayUrl}/v1/messages`);

        // Same key, same limits, rendered identically in both dialogs.
        expect(detailBudget).toBe(createdBudget);

        // The stored prefix shows directly, has no eye toggle, and is never
        // the full key.
        const detailField = detail.getByRole("textbox", { name: "API key prefix" });
        const shownPrefix = await detailField.inputValue();
        expect(shownPrefix).toBe(plaintext.slice(0, 12));
        expect(shownPrefix.length).toBeLessThan(plaintext.length);
        await expect(detail.getByRole("button", { name: /^(Show|Hide) API key/ })).toHaveCount(0);

        await detail.getByRole("button", { name: "Copy API key prefix" }).click();
        await expect(detail.getByRole("button", { name: "Copy API key prefix" })).toHaveAttribute(
          "title",
          "Copied",
        );
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shownPrefix);

        await expectNoOverflow(page, "detail dialog");
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
