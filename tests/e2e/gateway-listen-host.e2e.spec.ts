import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";

test("gateway binds loopback by default", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_listen_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const port = await getFreePort();
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_HOST: "" },
      port,
    });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForGateway(baseUrl, gateway);
      const listenSockets = readGatewayListenSockets(port);
      expect(listenSockets).toContain(`127.0.0.1:${port}`);
      expect(listenSockets).not.toMatch(new RegExp(`(\\*|0\\.0\\.0\\.0):${port}\\b`));
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fixture.dispose();
  }
});

function readGatewayListenSockets(port: number): string {
  return execFileSync("lsof", ["-Pan", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
}

test("gateway honors GATEWAY_HOST override", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_listen_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const port = await getFreePort();
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_HOST: "127.0.0.1" },
      port,
    });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForGateway(baseUrl, gateway);
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fixture.dispose();
  }
});
