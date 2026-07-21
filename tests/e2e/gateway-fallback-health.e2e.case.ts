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

const apiKey = "llmi_gateway_fallback_health_key_119";

test("JSON fallback skips a recognized client request error without recording provider health", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_json_fallback_health_${randomUUID().replaceAll("-", "_")}`,
  });
  const failingProvider = await createFakeProviderServer();
  const succeedingProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_json`,
      fixture,
      providerBaseUrl: `${failingProvider.url}?mode=unsupported-parameter`,
      virtualModelName: "vm-json-fallback-health",
    });
    await seedFallbackProviderCandidate({
      fixture,
      providerBaseUrl: succeedingProvider.url,
      routePolicyId: seeded.routePolicyId,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({
        apiKey: `${apiKey}_json`,
        baseUrl,
        model: "vm-json-fallback-health",
        stream: false,
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(failingProvider.requests).toHaveLength(1);
      expect(succeedingProvider.requests).toHaveLength(1);

      await expect.poll(async () => countProviderHealthEvents(fixture, seeded.providerId)).toBe(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await succeedingProvider.close();
    await failingProvider.close();
    await fixture.dispose();
  }
});

test("Streaming fallback does not record connection health for a provider 5xx before first byte", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stream_fallback_health_${randomUUID().replaceAll("-", "_")}`,
  });
  const failingProvider = await createFakeProviderServer();
  const succeedingProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_stream`,
      fixture,
      providerBaseUrl: `${failingProvider.url}?mode=first-byte-failure`,
      virtualModelName: "vm-stream-fallback-health",
    });
    await seedFallbackProviderCandidate({
      fixture,
      providerBaseUrl: `${succeedingProvider.url}?mode=stream&stream_end_ms=20`,
      routePolicyId: seeded.routePolicyId,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({
        apiKey: `${apiKey}_stream`,
        baseUrl,
        model: "vm-stream-fallback-health",
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("fake");
      expect(failingProvider.requests).toHaveLength(3);
      expect(succeedingProvider.requests).toHaveLength(1);

      await expect.poll(async () => countProviderHealthEvents(fixture, seeded.providerId)).toBe(0);
      await expect
        .poll(async () => countProviderConnectionProbeJobs(fixture, seeded.providerId))
        .toBe(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await succeedingProvider.close();
    await failingProvider.close();
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

async function countProviderHealthEvents(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  providerId: string,
): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    "select count(*)::text as count from provider_health_events where provider_id = $1::uuid",
    [providerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countProviderConnectionProbeJobs(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  providerId: string,
): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    `
      select count(*)::text as count
      from jobs
      where job_type = 'provider_connection_probe'
        and payload->>'providerId' = $1
    `,
    [providerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function postChatCompletion(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  stream: boolean;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model,
      stream: input.stream,
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}
