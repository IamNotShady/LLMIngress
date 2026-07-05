import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
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

async function postStreamingChatCompletion(input: {
  agentApiKey: string;
  baseUrl: string;
  model: string;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model,
      stream: true,
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function readFirstStreamChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected streaming response body.");
  }
  const firstChunk = await reader.read();
  await reader.cancel().catch(() => undefined);
  return firstChunk.value ? new TextDecoder().decode(firstChunk.value) : "";
}

async function createSlowOtelServer(input: { delayMs: number }): Promise<{
  close: () => Promise<void>;
  requestCount: () => number;
  url: string;
}> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, input.delayMs);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start OTEL test server.");
  }
  return {
    close: () => closeServer(server),
    requestCount: () => requestCount,
    url: `http://127.0.0.1:${address.port}/v1/traces`,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
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

async function installSlowGatewayObservabilityTriggers(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  seconds: number;
}) {
  await input.fixture.query(`
    create or replace function slow_gateway_observability_write()
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
    create trigger slow_fallback_events_insert
    before insert on fallback_events
    for each row
    execute function slow_gateway_observability_write();
  `);
  await input.fixture.query(`
    create trigger slow_provider_api_keys_update
    before update on provider_api_keys
    for each row
    execute function slow_gateway_observability_write();
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

test("gateway returns non-streaming response before slow provider observability writes finish", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_observability_async_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();
  const otel = await createSlowOtelServer({ delayMs: 2_000 });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-observability-async",
    });
    await installSlowGatewayObservabilityTriggers({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otel.url,
        OTEL_TRACES_EXPORTER: "otlp",
      },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-observability-async",
      });
      const elapsedMs = Date.now() - startedAt;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(elapsedMs).toBeLessThan(1_500);
      await expect.poll(() => otel.requestCount()).toBeGreaterThan(0);

      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await otel.close();
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway streams first chunk before slow provider observability writes finish", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stream_observability_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();
  const otel = await createSlowOtelServer({ delayMs: 2_000 });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=stream&stream_end_ms=2500`,
      virtualModelName: "vm-stream-observability",
    });
    await installSlowGatewayObservabilityTriggers({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otel.url,
        OTEL_TRACES_EXPORTER: "otlp",
      },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postStreamingChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-stream-observability",
      });
      const firstChunk = await readFirstStreamChunk(response);
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      expect(firstChunk).toContain("fake");
      expect(elapsedMs).toBeLessThan(1_500);
      await expect.poll(() => otel.requestCount()).toBeGreaterThan(0);

      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await otel.close();
    await fakeProvider.close();
    await fixture.dispose();
  }
});
