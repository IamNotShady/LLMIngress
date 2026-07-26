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

        // --- A key is not bound to one platform: the list has no platform
        // filter and the detail states the integration base once.
        await page.goto(`${baseUrl}/api-keys?selected=${apiKeyId}`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByRole("heading", { level: 1, name: "API Keys" })).toBeVisible();
        await expect(page.locator("#api-key-filter-platform")).toHaveCount(0);
        await expect(page.getByText(`OpenAI-compatible base ${gatewayUrl}/v1`)).toBeVisible();
        await expect(page.getByText("guide-routed-vm").first()).toBeVisible();

        // The setup instructions stay available after creation, from the key's
        // own dialog rather than under the detail.
        await expect(page.getByRole("tablist", { name: "Integration platform" })).toHaveCount(0);
        await page.getByRole("link", { name: "Set up an agent" }).click();
        const setupDialog = page.getByRole("dialog", { name: "Set up an agent" });
        await expect(setupDialog).toContainText("guide-apiKey");
        await expect(setupDialog).toContainText("default model guide-routed-vm");

        const tablist = setupDialog.getByRole("tablist", { name: "Integration platform" });
        await expect(tablist.getByRole("tab")).toHaveCount(8);
        // The secret is stored hashed, so the snippets carry the prefix and the
        // dialog says what to do about it rather than looking complete.
        await expect(
          setupDialog.getByText("export LLMINGRESS_API_KEY='llmi_guide_k'"),
        ).toBeVisible();
        await expect(setupDialog.getByText(/snippets show the prefix only/)).toBeVisible();
        await tablist.getByRole("tab", { name: "Claude Code" }).click();
        await expect(page.getByText(/ANTHROPIC_BASE_URL=/)).toBeVisible();

        // --- Creating a key hands over every platform's setup, with the real
        // secret substituted for the placeholder.
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });
        const createDialog = page.getByRole("dialog", { name: "New API Key" });
        // A key is not created for one platform; the guides cover them all.
        await expect(createDialog.getByRole("combobox", { name: /platform/i })).toHaveCount(0);
        await expect(createDialog.getByLabel("Integration platform")).toHaveCount(0);
        await page.getByRole("link", { name: "Grant guide-routed-vm" }).click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await page.getByLabel("API key name").fill("guide-created-apiKey");
        await page.getByRole("button", { name: "Create key" }).click();

        await expect(page.getByText("SECRET · SHOWN ONCE")).toBeVisible();
        const apiKey = await page.getByLabel("API key secret").inputValue();
        expect(apiKey.startsWith("llmi_")).toBe(true);
        await expect(page.getByRole("radio")).toHaveCount(8);
        await expect(page.getByText(`export LLMINGRESS_API_KEY='${apiKey}'`)).toBeVisible();
        // The one-time screen is the only place the whole secret exists, so it
        // carries it rather than the prefix the detail has to fall back to.
        await expect(page.getByText("llmi_guide_k", { exact: true })).toHaveCount(0);

        await page.getByText("Other / curl", { exact: true }).click();
        await expect(page.getByText(`Use ${gatewayUrl} as the Gateway URL.`)).toBeVisible();

        // Both the one-time screen and the detail hold their layout at the
        // desktop target and on a phone.
        await page.evaluate(() => document.fonts.ready);
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await expect
            .poll(() => pageOverflowPx(page), { message: `created @ ${viewport.width}px` })
            .toBeLessThanOrEqual(0);
        }
        await page.goto(`${baseUrl}/api-keys?selected=${apiKeyId}`, { waitUntil: "networkidle" });
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await expect
            .poll(() => pageOverflowPx(page), { message: `detail @ ${viewport.width}px` })
            .toBeLessThanOrEqual(0);
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
