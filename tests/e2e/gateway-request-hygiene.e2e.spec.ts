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

const agentApiKey = "llmi_gateway_request_hygiene_key_094";

test("gateway accepts large bodies, protects metrics, and passes chat parameters through", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_hygiene_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-request-hygiene",
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_METRICS_TOKEN: "metrics-token" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const unauthorizedMetrics = await fetch(`${baseUrl}/metrics`);
      expect(unauthorizedMetrics.status).toBe(401);

      const authorizedMetrics = await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: "Bearer metrics-token" },
      });
      expect(authorizedMetrics.status).toBe(200);

      const largeMessage = "x".repeat(2 * 1024 * 1024);
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          max_completion_tokens: 64,
          messages: [{ content: largeMessage, role: "user" }],
          model: "vm-request-hygiene",
          seed: 7,
          stop: ["END"],
          top_p: 0.9,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(fakeProvider.requests).toHaveLength(1);
      const providerBody = fakeProvider.requests[0]?.bodyJson;
      expect(isRecord(providerBody) ? providerBody.max_tokens : undefined).toBe(64);
      expect(isRecord(providerBody) ? providerBody.seed : undefined).toBe(7);
      expect(isRecord(providerBody) ? providerBody.stop : undefined).toEqual(["END"]);
      expect(isRecord(providerBody) ? providerBody.top_p : undefined).toBe(0.9);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
