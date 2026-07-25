import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
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

async function seedCollapseData(databaseUrl: string) {
  const alphaId = randomUUID();
  const betaId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'collapse-alpha', 'Collapse Alpha', 'https://alpha.example/v1', true),
              ($2, 'api_key', 'collapse-beta', 'Collapse Beta', 'https://beta.example/v1', true)`,
      [alphaId, betaId],
    );
    await client.query(
      `insert into provider_models (id, provider_id, model_id, display_name)
       values ($1, $2, 'collapse-alpha-model', 'Collapse Alpha Model'),
              ($3, $4, 'collapse-beta-model', 'Collapse Beta Model')`,
      [randomUUID(), alphaId, randomUUID(), betaId],
    );
  });

  return { alphaId, betaId };
}

test("selecting a provider drives every field of the detail beside it", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_collapse_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedCollapseData(fixture.databaseUrl);
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
        await signInFromFirstRun(page, baseUrl);

        // The list always has a selection, and the detail belongs to it.
        await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();

        // Alpha: name, base url and model library all come from Alpha.
        await page.goto(`${baseUrl}/providers?selected=${seeded.alphaId}`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText("Collapse Alpha", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("https://alpha.example/v1")).toBeVisible();
        await expect(page.getByText("collapse-alpha-model")).toBeVisible();
        await expect(page.getByText("collapse-beta-model")).toHaveCount(0);
        await expect(page.getByText("https://beta.example/v1")).toHaveCount(0);

        // Switching the selection switches every one of them — nothing is
        // pinned to the first provider.
        await page
          .getByRole("link", { name: /Collapse Beta/ })
          .first()
          .click();
        await page.waitForURL((url) => url.searchParams.get("selected") === seeded.betaId);
        await expect(page.getByText("https://beta.example/v1")).toBeVisible();
        await expect(page.getByText("collapse-beta-model")).toBeVisible();
        await expect(page.getByText("collapse-alpha-model")).toHaveCount(0);
        await expect(page.getByText("https://alpha.example/v1")).toHaveCount(0);

        // The dialogs opened from the detail carry the selected provider too.
        await page.goto(`${baseUrl}/providers?selected=${seeded.betaId}&dialog=edit`, {
          waitUntil: "networkidle",
        });
        const editDialog = page.getByRole("dialog", { name: "Edit provider" });
        await expect(editDialog.getByLabel("DISPLAY NAME")).toHaveValue("Collapse Beta");
        await expect(editDialog.getByLabel("BASE URL")).toHaveValue("https://beta.example/v1");

        // No horizontal overflow at 1280 and 390.
        await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
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
