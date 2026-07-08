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

test("console api rejects unauthenticated API actions with 401", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_api_${randomUUID().replaceAll("-", "_")}`,
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
        await waitForConsole(baseUrl, consoleApp);
        const response = await fetch(`${baseUrl}/api/agents`, {
          body: new URLSearchParams({ action: "create" }),
          method: "POST",
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Authentication required." });
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});

test("console api keeps validation errors as 400 with their message", async ({ browser }) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_api_${randomUUID().replaceAll("-", "_")}`,
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
          const response = await page.request.post(`${baseUrl}/api/agents`, {
            form: { action: "create" },
          });
          expect(response.status()).toBe(400);
          const body = await response.json();
          expect(String(body.error)).toContain("required");
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
