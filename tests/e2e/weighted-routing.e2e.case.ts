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
import { seedGatewayRouteCandidate, seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const apiKey = "llmi_weighted_routing_key_2026";
const virtualModelName = "vm-weighted-routing";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type RouteReasonRow = {
  message: string;
  selected_weight: string | null;
  strategy: string;
};

async function readRouteReasonByRequestId(
  fixture: Fixture,
  requestId: string,
): Promise<RouteReasonRow | undefined> {
  const result = await fixture.query<RouteReasonRow>(
    `
      select route_reason->>'strategy' as strategy,
             route_reason->>'message' as message,
             route_reason->>'selectedWeight' as selected_weight
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0];
}

async function countFallbackEventsByRequestId(
  fixture: Fixture,
  requestId: string,
): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    `
      select count(*)::text as count
      from fallback_events fe
      join request_activity ra on ra.id = fe.request_activity_id
      where ra.request_id = $1
    `,
    [requestId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function postChatCompletion(input: {
  baseUrl: string;
  requestId?: string;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: virtualModelName,
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(input.requestId ? { "x-request-id": input.requestId } : {}),
    },
    method: "POST",
  });
}

test("a weighted route sends every request to the full-weight candidate and records the weight it drew", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_weighted_routing_${randomUUID().replaceAll("-", "_")}`,
  });
  const fallbackOnlyProvider = await createFakeProviderServer();
  const fullWeightProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    // The zero-weight candidate sits FIRST in candidate order: if weights were
    // ignored, order-based selection would serve it, so this test fails loudly
    // rather than passing by accident.
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "fallback-only-model",
      providerBaseUrl: fallbackOnlyProvider.url,
      strategy: "weighted",
      virtualModelName,
      weight: 0,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "full-weight-model",
      providerBaseUrl: fullWeightProvider.url,
      routePolicyId: seeded.routePolicyId,
      weight: 1,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // A 1.00 weight owns the whole [0, 1) draw span, so this is
      // deterministic rather than statistical: the zero-weight candidate never
      // sees primary traffic no matter what Math.random returns.
      const requestId = `test_weighted_${randomUUID()}`;
      for (let index = 0; index < 5; index++) {
        const response = await postChatCompletion({
          baseUrl,
          requestId: index === 0 ? requestId : undefined,
        });
        expect(response.status).toBe(200);
      }
      expect(fullWeightProvider.requests).toHaveLength(5);
      expect(fallbackOnlyProvider.requests).toHaveLength(0);
      expect(fullWeightProvider.requests[0]?.bodyJson).toMatchObject({
        model: "full-weight-model",
      });
      await expect
        .poll(async () => readRouteReasonByRequestId(fixture, requestId), { timeout: 20_000 })
        .toMatchObject({ selected_weight: "1", strategy: "weighted" });
      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.message).toBe(
        `weighted route for ${virtualModelName} selected candidate 2 with weight 1.00.`,
      );
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fullWeightProvider.close();
    await fallbackOnlyProvider.close();
    await fixture.dispose();
  }
});

test("a failing full-weight candidate falls back to the zero-weight one and the fallback is recorded", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_weighted_fallback_${randomUUID().replaceAll("-", "_")}`,
  });
  const fallbackProvider = await createFakeProviderServer();
  const failingProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "fallback-only-model",
      providerBaseUrl: fallbackProvider.url,
      strategy: "weighted",
      virtualModelName,
      weight: 0,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "full-weight-model",
      providerBaseUrl: `${failingProvider.url}?mode=unsupported-parameter`,
      routePolicyId: seeded.routePolicyId,
      weight: 1,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // The full-weight candidate refuses; the zero-weight candidate - drawn
      // last, kept as fallback - answers, and the burned attempt is recorded.
      const requestId = `test_weighted_fallback_${randomUUID()}`;
      const response = await postChatCompletion({ baseUrl, requestId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: "fake provider response" } }],
      });
      expect(failingProvider.requests).toHaveLength(1);
      expect(fallbackProvider.requests).toHaveLength(1);
      await expect
        .poll(async () => countFallbackEventsByRequestId(fixture, requestId), { timeout: 20_000 })
        .toBe(2);
      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.strategy).toBe("weighted");
      expect(reason?.selected_weight).toBe("1");
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await failingProvider.close();
    await fallbackProvider.close();
    await fixture.dispose();
  }
});
