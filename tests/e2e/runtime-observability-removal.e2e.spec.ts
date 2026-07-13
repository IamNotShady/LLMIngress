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
import {
  type GatewayProcess,
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { withProcessLock } from "../support/process-lock";

test("Gateway exposes real liveness/readiness and no metrics endpoint", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_readiness_${randomUUID().replaceAll("-", "_")}`,
  });
  let fixtureDisposed = false;
  let gateway: GatewayProcess | undefined;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });
    const baseUrl = `http://127.0.0.1:${gateway.port}`;
    await waitForGateway(baseUrl, gateway);

    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ service: "gateway", status: "ok" });

    for (const path of ["/health", "/health/ready"]) {
      const ready = await fetch(`${baseUrl}${path}`);
      expect(ready.status, path).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({ configVersion: 0, status: "ok" });
    }
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(404);

    await fixture.dispose();
    fixtureDisposed = true;
    const unavailable = await fetch(`${baseUrl}/health/ready`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ status: "unavailable" });
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  } finally {
    if (gateway) {
      await stopGatewayProcess(gateway);
    }
    if (!fixtureDisposed) {
      await fixture.dispose();
    }
  }
});

test("removed Runtime and Settings Console pages return 404", async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_runtime_pages_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await withProcessLock("llmingress-console-next-dev", async () => {
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
    });
  } finally {
    await fixture.dispose();
  }
});
