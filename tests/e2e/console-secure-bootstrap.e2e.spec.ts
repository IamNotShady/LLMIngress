import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

test("non-loopback fresh console without setup token is locked and POST returns 503", async ({
  page,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_bootstrap_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        env: { CONSOLE_HOST: "0.0.0.0" },
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        await waitForConsole(baseUrl, consoleApp);
        await page.goto(baseUrl);
        await expect(page.getByRole("heading", { name: "Setup locked" })).toBeVisible();

        const response = await fetch(`${baseUrl}/api/auth/setup`, {
          body: new URLSearchParams({ password: "correct horse battery staple" }),
          headers: { origin: baseUrl },
          method: "POST",
        });
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          code: "console_setup_locked",
          error: "Console setup is locked until CONSOLE_SETUP_TOKEN is configured.",
        });
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});

test("non-loopback fresh console requires the configured setup token before creating admin", async ({
  page,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_bootstrap_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await withProcessLock("llmingress-console-next-dev", async () => {
      const setupToken = "s".repeat(32);
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        env: { CONSOLE_HOST: "0.0.0.0", CONSOLE_SETUP_TOKEN: setupToken },
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        await waitForConsole(baseUrl, consoleApp);
        await page.goto(baseUrl);
        await expect(page.getByRole("heading", { name: "First run setup" })).toBeVisible();
        await expect(page.getByLabel("Setup token")).toBeVisible();

        const wrong = await fetch(`${baseUrl}/api/auth/setup`, {
          body: new URLSearchParams({
            password: "correct horse battery staple",
            setupToken: "wrong".repeat(8),
          }),
          headers: { origin: baseUrl },
          method: "POST",
        });
        expect(wrong.status).toBe(403);
        await expect(wrong.json()).resolves.toMatchObject({
          code: "console_setup_token_invalid",
          error: "Console setup token is invalid.",
        });

        const created = await fetch(`${baseUrl}/api/auth/setup`, {
          body: new URLSearchParams({
            password: "correct horse battery staple",
            setupToken,
          }),
          headers: { origin: baseUrl },
          method: "POST",
          redirect: "manual",
        });
        expect([303, 307, 308]).toContain(created.status);

        const admins = await fixture.query("select count(*)::integer as count from console_admins");
        expect(admins.rows[0]?.count).toBe(1);

        const alreadyInitialized = await fetch(`${baseUrl}/api/auth/setup`, {
          body: new URLSearchParams({
            password: "correct horse battery staple",
            setupToken,
          }),
          headers: { origin: baseUrl },
          method: "POST",
        });
        expect(alreadyInitialized.status).toBe(409);
        await expect(alreadyInitialized.json()).resolves.toMatchObject({
          code: "console_already_initialized",
          error: "Console is already initialized.",
        });
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
