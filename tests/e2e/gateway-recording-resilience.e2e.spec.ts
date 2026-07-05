import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const agentApiKey = "llmi_gateway_recording_resilience_key_094";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChatCompletion(input: { agentApiKey: string; baseUrl: string; model: string }) {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model,
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function installSlowRequestActivityUpdateTrigger(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  seconds: number;
}) {
  await input.fixture.query(`
    create or replace function slow_request_activity_update()
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
    create trigger slow_request_activity_update
    before update on request_activity
    for each row
    execute function slow_request_activity_update();
  `);
}

test("gateway still returns the LLM response when recording tables are unavailable", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_recording_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-recording",
    });
    await fixture.query("drop table request_activity cascade");

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-recording",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway returns non-streaming response before slow activity completion finishes", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_recording_async_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-recording-async",
    });
    await installSlowRequestActivityUpdateTrigger({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-recording-async",
      });
      const elapsedMs = Date.now() - startedAt;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(elapsedMs).toBeLessThan(1_500);

      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});
