import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  type GatewayProcess,
  getFreePort,
  startGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const agentApiKey = "llmi_gateway_lifecycle_drain_key";

test("gateway shutdown drains background tasks and exits non-zero when the drain times out", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_lifecycle_drain_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-lifecycle-drain",
    });
    await installSlowRequestActivityInsertTrigger({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_SHUTDOWN_DRAIN_MS: "50" },
      port: await getFreePort(),
    });
    const baseUrl = `http://127.0.0.1:${gateway.port}`;

    try {
      await waitForGateway(baseUrl, gateway);
      const response = await postChatCompletion({ baseUrl });
      expect(response.status).toBe(200);
      await response.text();

      process.kill(readGatewayListenPid(gateway.port), "SIGTERM");
      const exitCode = await waitForGatewayExit(gateway);
      const output = gateway.stdout.join("") + gateway.stderr.join("");

      expect(exitCode).not.toBe(0);
      expect(output).toContain("gateway background task drain timed out");
      expect(output).toContain("gateway.activity");
    } finally {
      if (gateway.child.exitCode === null) {
        gateway.child.kill("SIGKILL");
      }
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

async function postChatCompletion(input: { baseUrl: string }): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: "vm-lifecycle-drain",
    }),
    headers: {
      authorization: `Bearer ${agentApiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function readGatewayListenPid(port: number): number {
  return Number(
    execFileSync("lsof", ["-t", "-Pan", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim(),
  );
}

async function installSlowRequestActivityInsertTrigger(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  seconds: number;
}): Promise<void> {
  await input.fixture.query(`
    create or replace function slow_request_activity_insert_for_drain()
    returns trigger
    language plpgsql
    as $$
    begin
      perform pg_sleep(${input.seconds});
      return new;
    end;
    $$;
  `);
  await input.fixture.query(`
    create trigger slow_request_activity_insert_for_drain
    before insert on request_activity
    for each row
    execute function slow_request_activity_insert_for_drain();
  `);
}

async function waitForGatewayExit(gateway: GatewayProcess): Promise<number | null> {
  if (gateway.child.exitCode !== null) {
    return gateway.child.exitCode;
  }

  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Gateway did not exit after SIGTERM."));
    }, 5_000);
    gateway.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
