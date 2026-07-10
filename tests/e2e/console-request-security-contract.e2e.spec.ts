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

test("console mutating requests require a same-origin Origin before auth, including setup login and logout", async () => {
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

        for (const path of [
          "/api/agents",
          "/api/auth/setup",
          "/api/auth/login",
          "/api/auth/logout",
        ]) {
          const missing = await fetch(`${baseUrl}${path}`, {
            body: new URLSearchParams({ action: "create" }),
            method: "POST",
          });
          expect(missing.status, `${path} missing Origin`).toBe(403);
          await expect(missing.json()).resolves.toMatchObject({
            code: "csrf_origin_mismatch",
            error: "Request origin is not allowed.",
          });

          const nullOrigin = await fetch(`${baseUrl}${path}`, {
            body: new URLSearchParams({ action: "create" }),
            headers: { origin: "null" },
            method: "POST",
          });
          expect(nullOrigin.status, `${path} null Origin`).toBe(403);

          const crossOrigin = await fetch(`${baseUrl}${path}`, {
            body: new URLSearchParams({ action: "create" }),
            headers: { origin: "http://example.test" },
            method: "POST",
          });
          expect(crossOrigin.status, `${path} cross Origin`).toBe(403);
        }

        const safeGet = await fetch(`${baseUrl}/api/config-export`);
        expect(safeGet.status).toBe(401);

        const sameOrigin = await fetch(`${baseUrl}/api/auth/setup`, {
          body: new URLSearchParams(),
          headers: { origin: baseUrl },
          method: "POST",
        });
        expect(sameOrigin.status).toBe(400);
        await expect(sameOrigin.json()).resolves.toMatchObject({
          code: "form_field_required",
          error: "Admin password is required.",
        });
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});

test("console config import validation errors use stable codes and do not expose parser details", async ({
  browser,
}) => {
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
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);

          const response = await page.request.post(`${baseUrl}/api/config-import`, {
            form: { configJson: "{ not json with /tmp/secret.sql" },
            headers: { origin: baseUrl },
          });
          expect(response.status()).toBe(400);
          const body = await response.json();
          expect(body).toMatchObject({
            code: "config_import_invalid_json",
            error: "Config import JSON is invalid.",
          });
          expect(JSON.stringify(body)).not.toContain("/tmp/secret.sql");
          expect(JSON.stringify(body)).not.toContain("Unexpected");
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
