import { randomUUID } from "node:crypto";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
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

const apiKey = "llmi_gateway_circuit_breaker_key_121";

test("circuit breaker trips to the fallback provider and recovers through half-open", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_gateway_breaker_${randomUUID().replaceAll("-", "_")}`,
  });
  const flakyProvider = await createFakeProviderServer();
  const fallbackProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_trip`,
      fixture,
      providerBaseUrl: `${flakyProvider.url}?mode=flaky&fail_times=3`,
      virtualModelName: "vm-circuit-breaker",
    });
    await seedFallbackProviderCandidate({
      fixture,
      providerBaseUrl: fallbackProvider.url,
      routePolicyId: seeded.routePolicyId,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: {
        GATEWAY_BREAKER_ERROR_THRESHOLD_PERCENT: "50",
        GATEWAY_BREAKER_HALF_OPEN_AFTER_MS: "1500",
        GATEWAY_BREAKER_HALF_OPEN_CALLS: "1",
        GATEWAY_BREAKER_MIN_REQUESTS: "3",
        GATEWAY_BREAKER_WINDOW_MS: "60000",
        GATEWAY_HEALTH_SUMMARY_CACHE_TTL_MS: "0",
        GATEWAY_PROVIDER_RETRIES: "0",
      },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);
      const send = () =>
        postChatCompletion({ apiKey: `${apiKey}_trip`, baseUrl, model: "vm-circuit-breaker" });

      // Phase 1: three transient failures fall back and trip the breaker on the 3rd.
      for (let index = 0; index < 3; index += 1) {
        expect((await send()).status).toBe(200);
      }
      expect(flakyProvider.requests).toHaveLength(3);
      expect(fallbackProvider.requests).toHaveLength(3);

      // Phase 2: circuit open — the flaky connection is filtered in memory, no call reaches it.
      expect((await send()).status).toBe(200);
      expect(flakyProvider.requests).toHaveLength(3);
      expect(fallbackProvider.requests).toHaveLength(4);

      // Phase 3: past halfOpenAfter, the half-open trial routes back to the recovered provider.
      await new Promise((resolve) => setTimeout(resolve, 1_600));

      expect((await send()).status).toBe(200);
      expect(flakyProvider.requests).toHaveLength(4);
      expect(fallbackProvider.requests).toHaveLength(4);

      // Phase 4: trial success closed the circuit; traffic stays on the primary.
      expect((await send()).status).toBe(200);
      expect(flakyProvider.requests).toHaveLength(5);
      expect(fallbackProvider.requests).toHaveLength(4);

      const probeJobs = await fixture.query<{ count: string }>(
        `
          select count(*)::text as count
          from jobs
          where job_type = 'provider_connection_probe'
            and payload->>'providerId' = $1
        `,
        [seeded.providerId],
      );
      expect(Number(probeJobs.rows[0]?.count ?? 0)).toBe(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fallbackProvider.close();
    await flakyProvider.close();
    await fixture.dispose();
  }
});

test("transient provider errors retry the same connection before falling back", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_gateway_retry_${randomUUID().replaceAll("-", "_")}`,
  });
  const flakyProvider = await createFakeProviderServer();
  const fallbackProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_retry`,
      fixture,
      providerBaseUrl: `${flakyProvider.url}?mode=flaky&fail_times=1`,
      virtualModelName: "vm-circuit-retry",
    });
    await seedFallbackProviderCandidate({
      fixture,
      providerBaseUrl: fallbackProvider.url,
      routePolicyId: seeded.routePolicyId,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: {
        GATEWAY_BREAKER_MIN_REQUESTS: "100",
        GATEWAY_PROVIDER_RETRIES: "2",
        GATEWAY_PROVIDER_RETRY_INITIAL_DELAY_MS: "10",
      },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({
        apiKey: `${apiKey}_retry`,
        baseUrl,
        model: "vm-circuit-retry",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(flakyProvider.requests).toHaveLength(2);
      expect(fallbackProvider.requests).toHaveLength(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fallbackProvider.close();
    await flakyProvider.close();
    await fixture.dispose();
  }
});

async function seedFallbackProviderCandidate(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  providerBaseUrl: string;
  routePolicyId: string;
}): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: "test-master-key" }).encrypt(
    "fallback-provider-key",
  );

  await input.fixture.query(
    `
      insert into providers (
        id,
        provider_type,
        provider_key,
        provider_template_id,
        display_name,
        base_url,
        enabled
      )
      values ($1, 'api_key', 'openai', null, 'OpenAI Fallback', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
  await input.fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [randomUUID(), providerId, "fallback-pro", JSON.stringify(encrypted), encrypted.keyId],
  );
  await input.fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        input_modalities,
        output_modalities,
        context_window,
        max_output_tokens,
        supports_streaming,
        supports_function_calling,
        supports_reasoning,
        availability
      )
      values ($1, $2, 'fake-model', 'Fake Fallback Model', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
    `,
    [providerModelId, providerId],
  );
  await input.fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order
      )
      values ($1, $2, $3, 2)
    `,
    [randomUUID(), input.routePolicyId, providerModelId],
  );
}

async function postChatCompletion(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}
