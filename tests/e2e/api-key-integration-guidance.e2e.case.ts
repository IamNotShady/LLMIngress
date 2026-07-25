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
        await expect(page.getByText("guide-routed-vm")).toBeVisible();

        // --- Creating a key hands over every platform's setup, with the real
        // secret substituted for the placeholder.
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });
        await expect(page.getByLabel("Integration platform")).toHaveCount(0);
        await page.getByRole("link", { name: "Grant guide-routed-vm" }).click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await page.getByLabel("API key name").fill("guide-created-apiKey");
        await page.getByRole("button", { name: "Create key" }).click();

        await expect(page.getByText("SECRET · SHOWN ONCE")).toBeVisible();
        const apiKey = await page.getByLabel("API key secret").inputValue();
        expect(apiKey.startsWith("llmi_")).toBe(true);
        await expect(page.getByRole("radio")).toHaveCount(8);
        await expect(page.getByText(`export LLMINGRESS_API_KEY='${apiKey}'`)).toBeVisible();
        // The placeholder never survives into the snippet handed over.
        await expect(page.getByText("<YOUR_API_KEY>")).toHaveCount(0);

        await page.getByText("Other", { exact: true }).click();
        await expect(page.getByText(`Use ${gatewayUrl} as the Gateway URL.`)).toBeVisible();
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
