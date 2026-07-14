import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

test("template Provider creation persists the submitted display name", async ({ page }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_display_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      await waitForConsole(baseUrl, consoleApp);
      await signInFromFirstRun(page, baseUrl);

      await page.goto(`${baseUrl}/providers?providerDialog=new`);
      const dialog = page.getByRole("dialog", { name: "Add Provider" });
      await dialog.getByRole("tab", { name: "Local" }).click();
      await dialog.getByLabel("Provider type", { exact: true }).selectOption("ollama");
      await dialog.getByLabel("Provider display name").fill("  Home Ollama  ");
      await dialog.getByLabel("Provider base URL").fill("http://127.0.0.1:11434/v1");
      await dialog.getByRole("button", { name: "Create" }).click();

      await expect(page).toHaveURL(`${baseUrl}/providers`);
      await expect(page.getByText("Home Ollama", { exact: true })).toBeVisible();
      const stored = await fixture.query(
        "select display_name from providers where provider_key = 'ollama'",
      );
      expect(stored.rows).toEqual([{ display_name: "Home Ollama" }]);
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await fixture.dispose();
  }
});
