import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
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

test("ApiKey dialogs show endpoint groups and integration tabs without the platform field", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_api_key_guide_e2e_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const apiKeyId = randomUUID();
    const routedVmId = randomUUID();
    const unroutedVmId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      await client.query(
        `insert into virtual_models (id, name, description, enabled)
         values ($1, 'guide-routed-vm', 'Routed VM', true),
                ($2, 'guide-unrouted-vm', 'Unrouted VM', true)`,
        [routedVmId, unroutedVmId],
      );
      await client.query(
        `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
         values ($1, $2, 'fixed', 'messages')`,
        [randomUUID(), routedVmId],
      );
      await client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled, default_virtual_model_id)
         values ($1, 'guide-apiKey', 'llmi_guide_k', 'test-hash', true, $2)`,
        [apiKeyId, routedVmId],
      );
      await client.query(
        `insert into api_key_virtual_models (api_key_id, virtual_model_id)
         values ($1, $2), ($1, $3)`,
        [apiKeyId, routedVmId, unroutedVmId],
      );
    });

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_URL: gatewayUrl },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await waitForConsole(baseUrl, consoleApp);
        await page.setViewportSize({ width: 1280, height: 800 });
        await signInFromFirstRun(page, baseUrl);

        // Platform filter is gone from the ApiKeys list.
        await page.goto(`${baseUrl}/api-keys`);
        await expect(page.getByRole("heading", { name: "API Key list" })).toBeVisible();
        await expect(page.locator("#api-key-filter-platform")).toHaveCount(0);

        // Detail dialog: no Platform row, endpoint groups, 8 integration tabs.
        await page.goto(`${baseUrl}/api-keys?apiKeyView=${apiKeyId}`);
        const dialog = page.getByRole("dialog", { name: "guide-apiKey" });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator("dt").filter({ hasText: "Platform" })).toHaveCount(0);

        await expect(dialog).toContainText(`${gatewayUrl}/v1/messages`);
        const routedGroup = dialog.locator(".api-key-endpoint-group", {
          hasText: "/v1/messages",
        });
        await expect(routedGroup).toContainText("guide-routed-vm");
        const unroutedGroup = dialog.locator(".api-key-endpoint-group-unrouted");
        await expect(unroutedGroup).toContainText("No route policy configured");
        await expect(unroutedGroup).toContainText("guide-unrouted-vm");

        const tablist = dialog.getByRole("tablist", { name: "Integration platform" });
        await expect(tablist.getByRole("tab")).toHaveCount(8);
        await expect(tablist.getByRole("tab", { name: "Codex" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await tablist.getByRole("tab", { name: "Claude Code" }).click();
        await expect(dialog).toContainText("ANTHROPIC_BASE_URL=");
        await expect(dialog).toContainText("<YOUR_API_KEY>");
        await expect(dialog).toContainText("llmi_guide_k");

        // The allowed-VM list is redundant with the endpoint groups.
        await expect(dialog.getByRole("heading", { name: "Allowed Virtual Models" })).toHaveCount(
          0,
        );

        // Two columns side by side with aligned bottoms on desktop, stacked
        // on mobile, and no horizontal overflow at both checkpoints.
        const dialogColumns = dialog.locator(".api-key-view-column");
        await expect(dialogColumns).toHaveCount(2);
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await pageOverflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
          const leftBox = await dialogColumns.nth(0).boundingBox();
          const rightBox = await dialogColumns.nth(1).boundingBox();
          if (!leftBox || !rightBox) {
            throw new Error(`ApiKey view columns are not visible at ${viewport.width}px.`);
          }
          if (viewport.width === 1280) {
            expect(rightBox.x, "columns sit side by side at 1280px").toBeGreaterThanOrEqual(
              leftBox.x + leftBox.width - 1,
            );
            expect(
              Math.abs(leftBox.y + leftBox.height - (rightBox.y + rightBox.height)),
              "column bottoms align at 1280px",
            ).toBeLessThanOrEqual(2);
          } else {
            expect(rightBox.y, "columns stack at 390px").toBeGreaterThanOrEqual(
              leftBox.y + leftBox.height - 1,
            );
          }
        }

        // Create flow: no platform field; created dialog reuses the tabs with
        // the one-time plaintext key; DB stores the default platform.
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${baseUrl}/api-keys?apiKeyDialog=new`);
        await expect(page.getByLabel("Name")).toBeVisible();
        await expect(page.getByLabel("Integration platform")).toHaveCount(0);
        await page.getByLabel("Name").fill("guide-created-apiKey");
        await page.getByLabel("guide-routed-vm").check();
        await page.getByRole("button", { name: "Create" }).click();

        const createdDialog = page.getByRole("dialog", { name: "API Key created" });
        await expect(createdDialog).toBeVisible();
        const apiKey = await createdDialog.getByRole("textbox", { name: "API key" }).inputValue();
        expect(apiKey.startsWith("llmi_")).toBe(true);
        await expect(createdDialog.getByRole("tab")).toHaveCount(8);
        await expect(createdDialog).toContainText(`export LLMINGRESS_API_KEY='${apiKey}'`);
        await createdDialog.getByRole("tab", { name: "Other" }).click();
        await expect(createdDialog).toContainText(`Use ${gatewayUrl} as the Gateway URL.`);
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
