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

test("gateway serves a db-backed request and exits 0 on SIGTERM", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_hygiene_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const port = await getFreePort();
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port,
    });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: "Bearer llmi_nonexistent_key_for_hygiene_check" },
      });
      expect(response.status).toBe(401);

      process.kill(readGatewayListenPid(port), "SIGTERM");
      const exitCode = await new Promise<number | null>((resolve) => {
        gateway.child.once("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fixture.dispose();
  }
});

function readGatewayListenPid(port: number): number {
  return Number(
    execFileSync("lsof", ["-t", "-Pan", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim(),
  );
}
