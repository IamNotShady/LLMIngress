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
import { withProcessLock } from "../support/process-lock";

test("removed routing, Agent, and savings UI is unreachable", async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_core_routing_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await withProcessLock("llmingress-console-next-dev", async () => {
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

          expect((await page.request.get(`${baseUrl}/routing`)).status()).toBe(404);
          expect((await page.request.post(`${baseUrl}/api/route-policies/preview`)).status()).toBe(
            404,
          );

          await page.goto(`${baseUrl}/agents?dialog=new`);
          await expect(page.getByLabel("Agent type")).toHaveCount(0);
          await expect(page.getByLabel("Detailed request metadata logging")).toHaveCount(0);

          await page.goto(`${baseUrl}/models?virtualModelDialog=new`);
          await expect(page.getByText("Quality first", { exact: true })).toHaveCount(0);

          await page.goto(`${baseUrl}/usage`);
          await expect(page.getByText(/savings/i)).toHaveCount(0);
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
