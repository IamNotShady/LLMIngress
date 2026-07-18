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

const apiKey = "llmi_gateway_stream_robustness_key_094";

test("gateway times out a hung non-streaming provider request", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_timeout_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=timeout`,
      virtualModelName: "vm-provider-timeout",
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { PROVIDER_REQUEST_TIMEOUT_MS: "500" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-provider-timeout",
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(response.status).toBe(502);
      expect(body).toMatchObject({
        error: { code: "provider_request_failed" },
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway terminates a streaming response that stalls after the first chunk", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stream_stall_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_stream`,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=stream-stall`,
      virtualModelName: "vm-stream-stall",
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_STREAM_IDLE_TIMEOUT_MS: "500" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-stream-stall",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${apiKey}_stream`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) {
        return;
      }

      const first = await reader.read();
      expect(first.done).toBe(false);

      const outcome = await Promise.race([
        readRemainingStream(reader),
        delay(5_000).then(() => "timeout" as const),
      ]);

      expect(outcome).not.toBe("timeout");
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway closes the upstream provider stream when the client aborts", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stream_abort_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_abort`,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=stream-stall`,
      virtualModelName: "vm-stream-abort",
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_STREAM_IDLE_TIMEOUT_MS: "30000" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-stream-abort",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${apiKey}_abort`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) {
        return;
      }
      const first = await reader.read();
      expect(first.done).toBe(false);

      controller.abort();
      await reader.cancel().catch(() => undefined);
      await waitFor(() =>
        fakeProvider.closedRequests.some((request) => request.mode === "stream-stall"),
      );
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

async function readRemainingStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<"done" | "error"> {
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return "done";
      }
    }
  } catch {
    return "error";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) {
      return;
    }
    await delay(50);
  }
  expect(predicate()).toBe(true);
}
