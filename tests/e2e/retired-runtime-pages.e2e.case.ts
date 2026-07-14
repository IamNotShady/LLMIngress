import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort as getFreeConsolePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

test("removed Runtime and Settings Console pages return 404", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_runtime_pages_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreeConsolePort(),
    });
    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);
        for (const path of ["/runtime", "/settings"]) {
          const response = await page.request.get(`${baseUrl}${path}`);
          expect(response.status(), path).toBe(404);
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
