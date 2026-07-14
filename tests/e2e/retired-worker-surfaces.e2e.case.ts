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

test("removed notification API and Settings page return 404", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_worker_slimming_${randomUUID().replaceAll("-", "_")}`,
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
        await signInFromFirstRun(page, baseUrl);

        const response = await page.request.post(`${baseUrl}/api/notification-channels`, {
          form: { action: "create", displayName: "removed", webhookUrl: "https://example.com" },
          headers: { origin: baseUrl },
        });
        expect(response.status()).toBe(404);

        const settings = await page.request.get(`${baseUrl}/settings`);
        expect(settings.status()).toBe(404);
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
