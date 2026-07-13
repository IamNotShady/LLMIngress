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

test("console mutating requests do not enforce request Origin", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_security_${randomUUID().replaceAll("-", "_")}`,
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

        const unauthenticated = await fetch(`${baseUrl}/api/agents`, {
          body: new URLSearchParams({ action: "create" }),
          method: "POST",
        });
        expect(unauthenticated.status).toBe(401);
        await expect(unauthenticated.json()).resolves.toMatchObject({
          code: "authentication_required",
        });

        const nullOrigin = await fetch(`${baseUrl}/api/auth/setup`, {
          body: new URLSearchParams(),
          headers: { origin: "null" },
          method: "POST",
        });
        expect(nullOrigin.status).toBe(400);
        await expect(nullOrigin.json()).resolves.toMatchObject({
          code: "form_field_required",
        });

        const crossOrigin = await fetch(`${baseUrl}/api/auth/login`, {
          body: new URLSearchParams(),
          headers: { origin: "http://example.test" },
          method: "POST",
        });
        expect(crossOrigin.status).toBe(400);
        await expect(crossOrigin.json()).resolves.toMatchObject({
          code: "form_field_required",
        });

        const logout = await fetch(`${baseUrl}/api/auth/logout`, {
          method: "POST",
          redirect: "manual",
        });
        expect([303, 307, 308]).toContain(logout.status);

        const safeGet = await fetch(`${baseUrl}/api/playground/result`);
        expect(safeGet.status).toBe(401);
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
