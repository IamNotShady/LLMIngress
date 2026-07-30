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

const apiKey = "llmi_tag_routing_key_2026";
const virtualModelName = "vm-tag-routing";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type RouteReasonRow = {
  matched_tag: string | null;
  message: string;
  requested_tag: string | null;
  strategy: string;
  tag_fallback: boolean | null;
};

async function readLatestRouteReason(fixture: Fixture): Promise<RouteReasonRow | undefined> {
  const result = await fixture.query<RouteReasonRow>(
    `
      select route_reason->>'strategy' as strategy,
             route_reason->>'message' as message,
             route_reason->>'requestedTag' as requested_tag,
             route_reason->>'matchedTag' as matched_tag,
             (route_reason->>'tagFallback')::boolean as tag_fallback
      from request_activity
      order by started_at desc, id desc
      limit 1
    `,
  );
  return result.rows[0];
}

async function countFallbackEvents(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    "select count(*)::text as count from fallback_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function postChatCompletion(input: {
  baseUrl: string;
  routeTag?: string;
  stream?: boolean;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: virtualModelName,
      ...(input.stream ? { stream: true } : {}),
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(input.routeTag ? { "x-llmingress-route-tag": input.routeTag } : {}),
    },
    method: "POST",
  });
}

test("a route tag selects its candidate and everything else falls back to the default one", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_tag_routing_${randomUUID().replaceAll("-", "_")}`,
  });
  const defaultProvider = await createFakeProviderServer();
  const fastProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "default-model",
      providerBaseUrl: defaultProvider.url,
      strategy: "tag",
      tags: ["default"],
      virtualModelName,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "fast-model",
      providerBaseUrl: fastProvider.url,
      routePolicyId: seeded.routePolicyId,
      tags: ["fast"],
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // 1. A known tag reaches the candidate it names, and the routing header is
      //    Gateway input rather than something the upstream sees.
      const tagged = await postChatCompletion({ baseUrl, routeTag: "Fast" });
      expect(tagged.status).toBe(200);
      expect(fastProvider.requests).toHaveLength(1);
      expect(defaultProvider.requests).toHaveLength(0);
      expect(fastProvider.requests[0]?.bodyJson).toMatchObject({ model: "fast-model" });
      expect(fastProvider.requests[0]?.headers["x-llmingress-route-tag"]).toBeUndefined();
      await expect
        .poll(async () => readLatestRouteReason(fixture))
        .toMatchObject({
          matched_tag: "fast",
          requested_tag: "fast",
          strategy: "tag",
          tag_fallback: false,
        });

      // 2. No tag is the default candidate's request.
      const untagged = await postChatCompletion({ baseUrl });
      expect(untagged.status).toBe(200);
      expect(defaultProvider.requests).toHaveLength(1);
      expect(defaultProvider.requests[0]?.bodyJson).toMatchObject({ model: "default-model" });
      await expect
        .poll(async () => readLatestRouteReason(fixture))
        .toMatchObject({
          matched_tag: null,
          requested_tag: null,
          tag_fallback: true,
        });

      // 3. An unknown tag is served rather than refused, and says so in the record.
      const unknown = await postChatCompletion({ baseUrl, routeTag: "does-not-exist" });
      expect(unknown.status).toBe(200);
      expect(defaultProvider.requests).toHaveLength(2);
      expect(fastProvider.requests).toHaveLength(1);
      await expect
        .poll(async () => readLatestRouteReason(fixture))
        .toMatchObject({
          matched_tag: null,
          requested_tag: "does-not-exist",
          tag_fallback: true,
        });
      const fallbackReason = await readLatestRouteReason(fixture);
      expect(fallbackReason?.message).toContain("does-not-exist");
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fastProvider.close();
    await defaultProvider.close();
    await fixture.dispose();
  }
});

test("a tag route fails closed when its default candidate is unavailable", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_tag_default_unavailable_${randomUUID().replaceAll("-", "_")}`,
  });
  const defaultProvider = await createFakeProviderServer();
  const fastProvider = await createFakeProviderServer();
  const cheapProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "default-model",
      providerBaseUrl: defaultProvider.url,
      strategy: "tag",
      tags: ["default"],
      virtualModelName,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "fast-model",
      providerBaseUrl: fastProvider.url,
      routePolicyId: seeded.routePolicyId,
      tags: ["fast"],
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 3,
      fixture,
      modelId: "cheap-model",
      providerBaseUrl: cheapProvider.url,
      routePolicyId: seeded.routePolicyId,
      tags: ["cheap"],
    });
    await fixture.query("update provider_models set availability = 'unavailable' where id = $1", [
      seeded.providerModelId,
    ]);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({ baseUrl, routeTag: "cheap" });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "provider_unavailable" },
      });
      expect(defaultProvider.requests).toHaveLength(0);
      expect(fastProvider.requests).toHaveLength(0);
      expect(cheapProvider.requests).toHaveLength(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await cheapProvider.close();
    await fastProvider.close();
    await defaultProvider.close();
    await fixture.dispose();
  }
});

test("a failing tagged candidate falls back only to the default one, and never past it", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_tag_fallback_${randomUUID().replaceAll("-", "_")}`,
  });
  const defaultProvider = await createFakeProviderServer();
  const fastProvider = await createFakeProviderServer();
  const cheapProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "default-model",
      providerBaseUrl: defaultProvider.url,
      strategy: "tag",
      tags: ["default"],
      virtualModelName,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "fast-model",
      providerBaseUrl: `${fastProvider.url}?mode=unsupported-parameter`,
      routePolicyId: seeded.routePolicyId,
      tags: ["fast"],
    });
    // A third candidate proves the chain stops at the default rather than
    // sweeping every candidate the policy holds.
    await seedGatewayRouteCandidate({
      candidateOrder: 3,
      fixture,
      modelId: "cheap-model",
      providerBaseUrl: cheapProvider.url,
      routePolicyId: seeded.routePolicyId,
      tags: ["cheap"],
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // 4. The tagged candidate fails; the default answers and the attempt is recorded.
      const response = await postChatCompletion({ baseUrl, routeTag: "fast" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: "fake provider response" } }],
      });
      expect(fastProvider.requests).toHaveLength(1);
      expect(defaultProvider.requests).toHaveLength(1);
      expect(cheapProvider.requests).toHaveLength(0);
      await expect.poll(async () => countFallbackEvents(fixture)).toBe(2);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await cheapProvider.close();
    await fastProvider.close();
    await defaultProvider.close();
    await fixture.dispose();
  }
});

test("a tag route exhausts after the default candidate and stops retrying once a stream starts", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_tag_exhaustion_${randomUUID().replaceAll("-", "_")}`,
  });
  const defaultProvider = await createFakeProviderServer();
  const fastProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "default-model",
      providerBaseUrl: `${defaultProvider.url}?mode=unsupported-parameter`,
      strategy: "tag",
      tags: ["default"],
      virtualModelName,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "fast-model",
      providerBaseUrl: `${fastProvider.url}?mode=unsupported-parameter`,
      routePolicyId: seeded.routePolicyId,
      tags: ["fast"],
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // 5. Both candidates refuse: exactly two attempts, then the client hears it.
      const exhausted = await postChatCompletion({ baseUrl, routeTag: "fast" });
      expect(exhausted.status).toBeGreaterThanOrEqual(400);
      expect(fastProvider.requests).toHaveLength(1);
      expect(defaultProvider.requests).toHaveLength(1);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fastProvider.close();
    await defaultProvider.close();
    await fixture.dispose();
  }
});

test("a tagged stream that fails after its first byte is never replayed on the default candidate", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_tag_streaming_${randomUUID().replaceAll("-", "_")}`,
  });
  const defaultProvider = await createFakeProviderServer();
  const fastProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "default-model",
      providerBaseUrl: `${defaultProvider.url}?mode=stream&stream_end_ms=20`,
      strategy: "tag",
      tags: ["default"],
      virtualModelName,
    });
    await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "fast-model",
      providerBaseUrl: `${fastProvider.url}?mode=midstream-error`,
      routePolicyId: seeded.routePolicyId,
      tags: ["fast"],
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // 6. The first byte already left the tagged candidate, so the default one is
      //    never asked: replaying a started stream would duplicate output.
      const response = await postChatCompletion({ baseUrl, routeTag: "fast", stream: true });
      expect(response.status).toBe(200);
      await response.text().catch(() => undefined);
      expect(fastProvider.requests).toHaveLength(1);
      expect(defaultProvider.requests).toHaveLength(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fastProvider.close();
    await defaultProvider.close();
    await fixture.dispose();
  }
});
