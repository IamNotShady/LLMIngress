import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { buildGatewayApiKeyHash } from "../../packages/gateway-runtime/src/gateway-auth";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedGatewayRouteCandidate, seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const apiKey = "llmi_ltmain_route_2026";
const virtualModelName = "vm-least-time-routing";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type RouteReasonRow = {
  explored: string | null;
  message: string;
  strategy: string;
  ttfbMs: number | null;
};

type FallbackEventRow = {
  duration_ms: number | null;
  provider_model_id: string;
  status: string;
};

const leastTimeGatewayEnv = {
  GATEWAY_LEAST_TIME_EXPLORE_PERCENT: "0",
  GATEWAY_LEAST_TIME_FLUSH_INTERVAL_MS: "200",
  GATEWAY_LEAST_TIME_MIN_SAMPLES: "1",
};

async function readRouteReasonByRequestId(
  fixture: Fixture,
  requestId: string,
): Promise<RouteReasonRow | undefined> {
  const result = await fixture.query<RouteReasonRow>(
    `
      select route_reason->>'strategy' as strategy,
             route_reason->>'message' as message,
             route_reason->>'explored' as explored,
             ttfb_ms as "ttfbMs"
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0];
}

async function readFallbackEventsByRequestId(
  fixture: Fixture,
  requestId: string,
): Promise<FallbackEventRow[]> {
  const result = await fixture.query<FallbackEventRow>(
    `
      select fe.provider_model_id, fe.status, fe.duration_ms
      from fallback_events fe
      join request_activity ra on ra.id = fe.request_activity_id
      where ra.request_id = $1
      order by fe.attempt_order asc
    `,
    [requestId],
  );
  return result.rows;
}

async function countRouteLatencyStatsRows(
  fixture: Fixture,
  providerModelId: string,
  metric: "total" | "ttfb",
): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    "select count(*)::text as count from route_latency_stats where provider_model_id = $1 and metric = $2",
    [providerModelId, metric],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function seedRouteLatencyStat(
  fixture: Fixture,
  input: {
    ewmaMs: number;
    metric: "total" | "ttfb";
    providerModelId: string;
    sampleCount?: number;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into route_latency_stats (
        provider_model_id, metric, ewma_ms, sample_count, last_sample_at, updated_at
      )
      values ($1, $2, $3, $4, now(), now())
    `,
    [input.providerModelId, input.metric, input.ewmaMs, input.sampleCount ?? 5],
  );
}

/**
 * Wires two already-measured provider_model_id rows (created independently
 * through their own single-candidate "fixed" routes) into a brand new
 * least_time route, without creating any new provider/provider_model rows of
 * its own. route_latency_stats keys on provider_model_id, so a sample earned
 * under one route policy carries straight over here.
 */
async function seedLeastTimeVirtualModel(
  fixture: Fixture,
  input: {
    apiKey: string;
    candidates: Array<{ candidateOrder: number; providerModelId: string }>;
    virtualModelName: string;
  },
): Promise<{ apiKeyId: string; routePolicyId: string; virtualModelId: string }> {
  const apiKeyId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

  await fixture.query(
    `
      insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
      values ($1, 'Least Time E2E ApiKey', $2, $3, true, false)
    `,
    [apiKeyId, input.apiKey.slice(0, 12), buildGatewayApiKeyHash(input.apiKey)],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, 'Least Time E2E VM', true)",
    [virtualModelId, input.virtualModelName],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values ($1, $2, 'least_time', 'chat_completions')",
    [routePolicyId, virtualModelId],
  );
  for (const candidate of input.candidates) {
    await fixture.query(
      `
        insert into route_policy_candidates (
          id, route_policy_id, provider_model_id, candidate_order, tags, weight
        )
        values ($1, $2, $3, $4, $5::text[], null)
      `,
      [randomUUID(), routePolicyId, candidate.providerModelId, candidate.candidateOrder, []],
    );
  }
  await fixture.query(
    "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
    [apiKeyId, virtualModelId],
  );

  return { apiKeyId, routePolicyId, virtualModelId };
}

async function postChatCompletion(input: {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  requestId?: string;
  stream?: boolean;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model ?? virtualModelName,
      ...(input.stream ? { stream: true } : {}),
    }),
    headers: {
      authorization: `Bearer ${input.apiKey ?? apiKey}`,
      "content-type": "application/json",
      ...(input.requestId ? { "x-request-id": input.requestId } : {}),
    },
    method: "POST",
  });
}

test("a least_time route converges on the faster candidate measured from real traffic", async () => {
  test.setTimeout(180_000);
  const slowWarmupApiKey = "llmi_lt1slow_warm_2026";
  const fastWarmupApiKey = "llmi_lt1fast_warm_2026";
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_least_time_converge_${randomUUID().replaceAll("-", "_")}`,
  });
  const slowProvider = await createFakeProviderServer();
  const fastProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    // The candidate that ends up first in configured order is deliberately the
    // SLOW one (delay_ms=400): if the route just followed candidate order, it
    // would fail loudly instead of passing by accident.
    const slowWarmup = await seedOpenAIGatewayRoute({
      apiKey: slowWarmupApiKey,
      fixture,
      modelId: "least-time-slow-model",
      providerBaseUrl: `${slowProvider.url}?mode=json&delay_ms=400`,
      strategy: "fixed",
      virtualModelName: "vm-least-time-warmup-slow",
    });
    const fastWarmup = await seedOpenAIGatewayRoute({
      apiKey: fastWarmupApiKey,
      fixture,
      modelId: "least-time-fast-model",
      providerBaseUrl: `${fastProvider.url}?mode=json&delay_ms=10`,
      strategy: "fixed",
      virtualModelName: "vm-least-time-warmup-fast",
    });
    await seedLeastTimeVirtualModel(fixture, {
      apiKey,
      candidates: [
        { candidateOrder: 1, providerModelId: slowWarmup.providerModelId },
        { candidateOrder: 2, providerModelId: fastWarmup.providerModelId },
      ],
      virtualModelName,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: leastTimeGatewayEnv,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // Warm-up: one real request per candidate, through its own
      // single-candidate route, so each provider_model_id earns a genuine EWMA
      // sample from real measured latency before the least_time route ever
      // sees them together. The wall-clock timing proves delay_ms is actually
      // honored by the fake provider, not just present in the URL.
      const slowWarmupStartedAtMs = Date.now();
      const slowWarmupResponse = await postChatCompletion({
        apiKey: slowWarmupApiKey,
        baseUrl,
        model: "vm-least-time-warmup-slow",
      });
      const slowWarmupElapsedMs = Date.now() - slowWarmupStartedAtMs;
      expect(slowWarmupResponse.status).toBe(200);
      expect(slowWarmupElapsedMs).toBeGreaterThanOrEqual(350);

      const fastWarmupResponse = await postChatCompletion({
        apiKey: fastWarmupApiKey,
        baseUrl,
        model: "vm-least-time-warmup-fast",
      });
      expect(fastWarmupResponse.status).toBe(200);
      expect(slowProvider.requests).toHaveLength(1);
      expect(fastProvider.requests).toHaveLength(1);

      // Now both candidates are warm; every subsequent least_time request
      // must converge on the one that was actually faster.
      const requestId = `test_least_time_converge_${randomUUID()}`;
      for (let index = 0; index < 3; index++) {
        const response = await postChatCompletion({
          baseUrl,
          requestId: index === 0 ? requestId : undefined,
        });
        expect(response.status).toBe(200);
      }
      expect(fastProvider.requests).toHaveLength(4);
      expect(slowProvider.requests).toHaveLength(1);

      await expect
        .poll(async () => readRouteReasonByRequestId(fixture, requestId), { timeout: 20_000 })
        .toMatchObject({ strategy: "least_time" });
      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.message).toBe(
        `least_time route for ${virtualModelName} selected fastest eligible candidate 2.`,
      );
      expect(reason?.explored).toBeNull();
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fastProvider.close();
    await slowProvider.close();
    await fixture.dispose();
  }
});

test("a failing fastest candidate falls back to the next-fastest one", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_least_time_fallback_${randomUUID().replaceAll("-", "_")}`,
  });
  const failingProvider = await createFakeProviderServer();
  const healthyProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    // A candidate that always fails can never earn a real success sample, so
    // its "was measured fast before it started failing" history is seeded
    // directly - the same technique already used for rate_limit_windows and
    // budget_periods E2E fixtures to establish pre-existing runtime state.
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "least-time-failing-model",
      providerBaseUrl: `${failingProvider.url}?mode=unsupported-parameter`,
      strategy: "least_time",
      virtualModelName,
    });
    const healthyCandidate = await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "least-time-healthy-model",
      providerBaseUrl: `${healthyProvider.url}?mode=json`,
      routePolicyId: seeded.routePolicyId,
    });
    await seedRouteLatencyStat(fixture, {
      ewmaMs: 10,
      metric: "total",
      providerModelId: seeded.providerModelId,
    });
    await seedRouteLatencyStat(fixture, {
      ewmaMs: 400,
      metric: "total",
      providerModelId: healthyCandidate.providerModelId,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: leastTimeGatewayEnv,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // The fastest-by-latency candidate is tried first, fails, and the
      // gateway falls back to the next-fastest (slower, but healthy) one.
      const requestId = `test_least_time_fallback_${randomUUID()}`;
      const response = await postChatCompletion({ baseUrl, requestId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: "fake provider response" } }],
      });
      expect(failingProvider.requests).toHaveLength(1);
      expect(healthyProvider.requests).toHaveLength(1);

      await expect
        .poll(async () => readFallbackEventsByRequestId(fixture, requestId), { timeout: 20_000 })
        .toHaveLength(2);
      const events = await readFallbackEventsByRequestId(fixture, requestId);
      const failedEvent = events.find((event) => event.status === "failed");
      const succeededEvent = events.find((event) => event.status === "succeeded");
      expect(failedEvent?.provider_model_id).toBe(seeded.providerModelId);
      expect(failedEvent?.duration_ms).not.toBeNull();
      expect(failedEvent?.duration_ms ?? -1).toBeGreaterThanOrEqual(0);
      expect(succeededEvent?.provider_model_id).toBe(healthyCandidate.providerModelId);

      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.strategy).toBe("least_time");
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await healthyProvider.close();
    await failingProvider.close();
    await fixture.dispose();
  }
});

test("a least_time stream is ordered by first-byte latency, not stream length", async () => {
  test.setTimeout(180_000);
  const slowWarmupApiKey = "llmi_lt3slow_warm_2026";
  const fastWarmupApiKey = "llmi_lt3fast_warm_2026";
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_least_time_ttfb_${randomUUID().replaceAll("-", "_")}`,
  });
  const slowFirstByteProvider = await createFakeProviderServer();
  const fastFirstByteProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    // Total stream length is reversed on purpose: the slow-first-byte
    // candidate finishes SOONER overall (450ms) than the fast-first-byte one
    // (610ms). Only first-byte latency may explain the routing outcome below.
    const slowWarmup = await seedOpenAIGatewayRoute({
      apiKey: slowWarmupApiKey,
      fixture,
      modelId: "least-time-slow-ttfb-model",
      providerBaseUrl: `${slowFirstByteProvider.url}?mode=stream&first_byte_ms=400&stream_end_ms=50`,
      strategy: "fixed",
      virtualModelName: "vm-least-time-ttfb-warmup-slow",
    });
    const fastWarmup = await seedOpenAIGatewayRoute({
      apiKey: fastWarmupApiKey,
      fixture,
      modelId: "least-time-fast-ttfb-model",
      providerBaseUrl: `${fastFirstByteProvider.url}?mode=stream&first_byte_ms=10&stream_end_ms=600`,
      strategy: "fixed",
      virtualModelName: "vm-least-time-ttfb-warmup-fast",
    });
    await seedLeastTimeVirtualModel(fixture, {
      apiKey,
      candidates: [
        { candidateOrder: 1, providerModelId: slowWarmup.providerModelId },
        { candidateOrder: 2, providerModelId: fastWarmup.providerModelId },
      ],
      virtualModelName,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: leastTimeGatewayEnv,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // Warm-up streams the ttfb pool specifically. The elapsed time to
      // response-headers proves first_byte_ms is honored (fetch() resolves
      // once headers arrive, before the body finishes).
      const slowWarmupStartedAtMs = Date.now();
      const slowWarmupResponse = await postChatCompletion({
        apiKey: slowWarmupApiKey,
        baseUrl,
        model: "vm-least-time-ttfb-warmup-slow",
        stream: true,
      });
      const slowWarmupHeadersElapsedMs = Date.now() - slowWarmupStartedAtMs;
      expect(slowWarmupResponse.status).toBe(200);
      expect(slowWarmupHeadersElapsedMs).toBeGreaterThanOrEqual(350);
      await slowWarmupResponse.text();

      const fastWarmupResponse = await postChatCompletion({
        apiKey: fastWarmupApiKey,
        baseUrl,
        model: "vm-least-time-ttfb-warmup-fast",
        stream: true,
      });
      expect(fastWarmupResponse.status).toBe(200);
      await fastWarmupResponse.text();
      expect(slowFirstByteProvider.requests).toHaveLength(1);
      expect(fastFirstByteProvider.requests).toHaveLength(1);

      const requestId = `test_least_time_ttfb_${randomUUID()}`;
      const response = await postChatCompletion({ baseUrl, requestId, stream: true });
      expect(response.status).toBe(200);
      await response.text();

      expect(fastFirstByteProvider.requests).toHaveLength(2);
      expect(slowFirstByteProvider.requests).toHaveLength(1);

      await expect
        .poll(async () => readRouteReasonByRequestId(fixture, requestId), { timeout: 20_000 })
        .toMatchObject({ strategy: "least_time" });
      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.message).toBe(
        `least_time route for ${virtualModelName} selected fastest eligible candidate 2.`,
      );
      expect(reason?.ttfbMs).not.toBeNull();
      expect(reason?.ttfbMs ?? Number.POSITIVE_INFINITY).toBeLessThan(300);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fastFirstByteProvider.close();
    await slowFirstByteProvider.close();
    await fixture.dispose();
  }
});

test("a gateway restart reseeds the latency ordering instead of starting cold", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_least_time_restart_${randomUUID().replaceAll("-", "_")}`,
  });
  const measuredProvider = await createFakeProviderServer();
  const distractorProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    // Only one candidate exists before the restart, so there is no ordering
    // ambiguity while it earns its real sample.
    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "least-time-measured-model",
      providerBaseUrl: `${measuredProvider.url}?mode=json`,
      strategy: "least_time",
      virtualModelName,
    });

    const port = await getFreePort();
    let gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: leastTimeGatewayEnv,
      port,
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const warmupResponse = await postChatCompletion({ baseUrl });
      expect(warmupResponse.status).toBe(200);
      expect(measuredProvider.requests).toHaveLength(1);

      // Wait for the flushed sample to actually land in Postgres before
      // restarting - this is the row a cold boot would NOT have.
      await expect
        .poll(async () => countRouteLatencyStatsRows(fixture, seeded.providerModelId, "total"), {
          timeout: 20_000,
        })
        .toBeGreaterThanOrEqual(1);
    } finally {
      await stopGatewayProcess(gateway);
    }

    // The already-measured candidate is bumped to order 2, and a brand new,
    // never-queried candidate is added at order 1 - the position a cold
    // (not-reseeded) boot would pick first, since a cold pick falls back to
    // configured order. It is configured to fail loudly if ever attempted.
    await fixture.query(
      "update route_policy_candidates set candidate_order = 2 where route_policy_id = $1",
      [seeded.routePolicyId],
    );
    const distractor = await seedGatewayRouteCandidate({
      candidateOrder: 1,
      fixture,
      modelId: "least-time-distractor-model",
      providerBaseUrl: `${distractorProvider.url}?mode=error`,
      routePolicyId: seeded.routePolicyId,
    });

    // A fresh port so the readiness probe can never be answered by the dying
    // previous instance over a kept-alive connection.
    const restartPort = await getFreePort();
    gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: leastTimeGatewayEnv,
      port: restartPort,
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // The FIRST request after restart must hit the reseeded, already-warm
      // candidate directly - never the newly added, configured-order-first,
      // never-measured distractor.
      const requestId = `test_least_time_restart_${randomUUID()}`;
      const response = await postChatCompletion({ baseUrl, requestId });
      expect(response.status).toBe(200);
      expect(measuredProvider.requests).toHaveLength(2);
      expect(distractorProvider.requests).toHaveLength(0);

      await expect
        .poll(async () => readRouteReasonByRequestId(fixture, requestId), { timeout: 20_000 })
        .toMatchObject({ strategy: "least_time" });
      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.message).toBe(
        `least_time route for ${virtualModelName} selected fastest eligible candidate 2.`,
      );
      void distractor;
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await distractorProvider.close();
    await measuredProvider.close();
    await fixture.dispose();
  }
});

test("an unmeasured candidate is explored and measured instead of being excluded forever", async () => {
  test.setTimeout(180_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_least_time_explore_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerA = await createFakeProviderServer();
  const providerB = await createFakeProviderServer();
  const providerC = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const seeded = await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      modelId: "least-time-explore-model-a",
      providerBaseUrl: `${providerA.url}?mode=json`,
      strategy: "least_time",
      virtualModelName,
    });
    const candidateB = await seedGatewayRouteCandidate({
      candidateOrder: 2,
      fixture,
      modelId: "least-time-explore-model-b",
      providerBaseUrl: `${providerB.url}?mode=json`,
      routePolicyId: seeded.routePolicyId,
    });

    const port = await getFreePort();
    const exploreEnv = { ...leastTimeGatewayEnv, GATEWAY_LEAST_TIME_EXPLORE_PERCENT: "100" };
    let gateway = startGatewayProcess({ databaseUrl: fixture.databaseUrl, env: exploreEnv, port });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // Request 1: both candidates cold, no explore possible yet (warm set is
      // empty) - falls back to configured order and warms A.
      const firstResponse = await postChatCompletion({ baseUrl });
      expect(firstResponse.status).toBe(200);
      expect(providerA.requests).toHaveLength(1);

      // Request 2: A is warm, B is the only cold candidate, and the 100%
      // explore ratio deterministically promotes it (there is nothing else
      // it could be) - B is measured too instead of staying excluded.
      const secondResponse = await postChatCompletion({ baseUrl });
      expect(secondResponse.status).toBe(200);
      expect(providerB.requests).toHaveLength(1);

      await expect
        .poll(
          async () =>
            Promise.all([
              countRouteLatencyStatsRows(fixture, seeded.providerModelId, "total"),
              countRouteLatencyStatsRows(fixture, candidateB.providerModelId, "total"),
            ]).then(([a, b]) => a + b),
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      await stopGatewayProcess(gateway);
    }

    // A brand new, never-queried third candidate joins after A and B are
    // already warm and reseeded.
    const candidateC = await seedGatewayRouteCandidate({
      candidateOrder: 3,
      fixture,
      modelId: "least-time-explore-model-c",
      providerBaseUrl: `${providerC.url}?mode=json`,
      routePolicyId: seeded.routePolicyId,
    });

    // A fresh port so the readiness probe can never be answered by the dying
    // previous instance over a kept-alive connection.
    const restartPort = await getFreePort();
    gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: exploreEnv,
      port: restartPort,
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      // Both prior candidates reseed as warm; C is the sole cold candidate,
      // and the 100% explore ratio deterministically serves it next - it is
      // measured rather than excluded forever.
      const requestId = `test_least_time_explore_${randomUUID()}`;
      const response = await postChatCompletion({ baseUrl, requestId });
      expect(response.status).toBe(200);
      expect(providerC.requests).toHaveLength(1);
      expect(providerA.requests).toHaveLength(1);
      expect(providerB.requests).toHaveLength(1);

      await expect
        .poll(async () => readRouteReasonByRequestId(fixture, requestId), { timeout: 20_000 })
        .toMatchObject({ strategy: "least_time" });
      const reason = await readRouteReasonByRequestId(fixture, requestId);
      expect(reason?.explored).toBe("true");
      expect(reason?.message).toBe(
        `least_time route for ${virtualModelName} selected exploration candidate 3 to gather latency samples.`,
      );
      void candidateC;
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await providerC.close();
    await providerB.close();
    await providerA.close();
    await fixture.dispose();
  }
});
