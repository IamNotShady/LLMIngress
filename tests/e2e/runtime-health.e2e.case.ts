import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  type GatewayProcess,
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";

test("Gateway exposes liveness and readiness", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_readiness_${randomUUID().replaceAll("-", "_")}`,
  });
  let fixtureDisposed = false;
  let gateway: GatewayProcess | undefined;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    gateway = startGatewayProcess({ databaseUrl: fixture.databaseUrl, port: await getFreePort() });
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

    await fixture.dispose();
    fixtureDisposed = true;
    const unavailable = await fetch(`${baseUrl}/health/ready`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ status: "unavailable" });
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  } finally {
    if (gateway) await stopGatewayProcess(gateway);
    if (!fixtureDisposed) await fixture.dispose();
  }
});
