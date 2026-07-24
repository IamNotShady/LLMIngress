import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
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

// Grok (Feature A) is the first subscription-type OpenAI chat_completions egress:
// a plain OAuth Bearer plus the upstream client's versioned identity headers (the
// proxy's HTTP 426 gate). Two scenarios against one mocked upstream:
//   1. non-streaming, routed through the grok subscription adapter;
//   2. streaming, routed through the grok streaming dialect.
// Both must carry the client headers to the /v1/chat/completions path and record
// a succeeded request_activity row.
const encryptionKey = "test-master-key";
const apiKey = "llmi_v1_grok_chat_egress_key_00000001";

const nonStreamingScenario = {
  accessToken: "grok-oauth-token-non-streaming",
  displayName: "Grok (non-streaming)",
  id: "grok_non_streaming",
  modelDisplayName: "Grok Code",
  modelId: "grok-code",
  protocol: "chat_completions",
  providerBaseUrlSuffix: "/grok-proxy/v1",
  expectedEgressPath: "/grok-proxy/v1/chat/completions",
  requestId: "req_grok_non_streaming_001",
  stream: false,
  virtualModelName: "grok-chat-non-streaming",
} as const;

const streamingScenario = {
  accessToken: "grok-oauth-token-streaming",
  displayName: "Grok (streaming)",
  id: "grok_streaming",
  modelDisplayName: "Grok Code Stream",
  modelId: "grok-code-stream",
  protocol: "chat_completions",
  // ?mode=stream drives the fake upstream's SSE response; joinUrl preserves the
  // query while appending /chat/completions to the path.
  providerBaseUrlSuffix: "/grok-proxy-stream/v1?mode=stream&stream_end_ms=20",
  expectedEgressPath: "/grok-proxy-stream/v1/chat/completions",
  requestId: "req_grok_streaming_001",
  stream: true,
  virtualModelName: "grok-chat-streaming",
} as const;

// Feature B: the responses face (the upstream's multi-agent variants are
// responses-only) routes through the same grok header adapter to /v1/responses.
const responsesScenario = {
  accessToken: "grok-oauth-token-responses",
  displayName: "Grok (responses)",
  id: "grok_responses",
  modelDisplayName: "Grok Multi-Agent",
  modelId: "grok-multi-agent",
  protocol: "responses",
  providerBaseUrlSuffix: "/grok-proxy-responses/v1",
  expectedEgressPath: "/grok-proxy-responses/v1/responses",
  requestId: "req_grok_responses_001",
  stream: false,
  virtualModelName: "grok-responses",
} as const;

type Scenario = typeof nonStreamingScenario | typeof streamingScenario | typeof responsesScenario;
type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;
type CapturedProviderRequest = Awaited<
  ReturnType<typeof createFakeProviderServer>
>["requests"][number];

test("grok routes subscription chat_completions egress with the OAuth Bearer and versioned client headers", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_grok_egress_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const nonStreamingVmId = await seedSubscriptionRoute(fixture, {
      fakeProviderUrl: fakeProvider.url,
      scenario: nonStreamingScenario,
    });
    const streamingVmId = await seedSubscriptionRoute(fixture, {
      fakeProviderUrl: fakeProvider.url,
      scenario: streamingScenario,
    });
    const responsesVmId = await seedSubscriptionRoute(fixture, {
      fakeProviderUrl: fakeProvider.url,
      scenario: responsesScenario,
    });
    await seedApiKey(fixture, [nonStreamingVmId, streamingVmId, responsesVmId]);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const nonStreamingResponse = await postScenario(baseUrl, nonStreamingScenario);
      expect(nonStreamingResponse.status).toBe(200);
      const nonStreamingBody = await nonStreamingResponse.json();
      expect(nonStreamingBody).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });

      const streamingResponse = await postScenario(baseUrl, streamingScenario);
      expect(streamingResponse.status).toBe(200);
      expect(await streamingResponse.text()).toContain("fake");

      const responsesResponse = await postScenario(baseUrl, responsesScenario);
      expect(responsesResponse.status).toBe(200);
      expect(await responsesResponse.text()).toContain("fake provider response");

      for (const scenario of [nonStreamingScenario, streamingScenario, responsesScenario]) {
        expectGrokEgress(findEgress(fakeProvider.requests, scenario), scenario);
      }

      await expectSucceededActivity(fixture);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

async function seedSubscriptionRoute(
  fixture: Fixture,
  input: { fakeProviderUrl: string; scenario: Scenario },
): Promise<string> {
  const { fakeProviderUrl, scenario } = input;
  const providerId = randomUUID();
  const oauthId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

  const blob = {
    accessToken: scenario.accessToken,
    expiresAt: null,
    refreshToken: null,
    scopes: [],
    tokenType: "Bearer",
  };
  const encrypted = createSecretEncryption({ kind: "inline", value: encryptionKey }).encrypt(
    JSON.stringify(blob),
  );

  await fixture.query(
    `insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled)
     values ($1, 'subscription', 'grok', 'grok', $2, $3, true)`,
    [providerId, scenario.displayName, `${fakeProviderUrl}${scenario.providerBaseUrlSuffix}`],
  );
  await fixture.query(
    `insert into provider_oauth (id, provider_id, enabled, encrypted_token, token_expires_at, completed_at)
     values ($1, $2, true, $3::jsonb, null, now())`,
    [oauthId, providerId, JSON.stringify(encrypted)],
  );
  await fixture.query(
    `insert into provider_models (id, provider_id, model_id, display_name, input_modalities, output_modalities, context_window, max_output_tokens, supports_streaming, supports_function_calling, supports_reasoning, availability)
     values ($1, $2, $3, $4, array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')`,
    [providerModelId, providerId, scenario.modelId, scenario.modelDisplayName],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
    [virtualModelId, scenario.virtualModelName, scenario.displayName],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values ($1, $2, 'fixed', $3)",
    [routePolicyId, virtualModelId, scenario.protocol],
  );
  await fixture.query(
    "insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order) values ($1, $2, $3, 1)",
    [randomUUID(), routePolicyId, providerModelId],
  );

  return virtualModelId;
}

async function seedApiKey(fixture: Fixture, virtualModelIds: string[]): Promise<void> {
  const apiKeyId = randomUUID();
  await fixture.query(
    `insert into api_keys (id, name, key_prefix, key_hash, default_virtual_model_id, enabled)
     values ($1, 'Grok Egress ApiKey', $2, $3, $4, true)`,
    [apiKeyId, apiKey.slice(0, 12), buildGatewayApiKeyHash(apiKey), virtualModelIds[0]],
  );
  for (const virtualModelId of virtualModelIds) {
    await fixture.query(
      "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
      [apiKeyId, virtualModelId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Grok egress config')",
  );
}

async function postScenario(baseUrl: string, scenario: Scenario): Promise<Response> {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-request-id": scenario.requestId,
  };
  if (scenario.protocol === "responses") {
    return fetch(`${baseUrl}/v1/responses`, {
      body: JSON.stringify({
        input: [
          { content: [{ text: `hello through ${scenario.id}`, type: "input_text" }], role: "user" },
        ],
        model: scenario.virtualModelName,
        stream: scenario.stream,
      }),
      headers,
      method: "POST",
    });
  }
  return fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
      model: scenario.virtualModelName,
      stream: scenario.stream,
    }),
    headers,
    method: "POST",
  });
}

function findEgress(
  requests: CapturedProviderRequest[],
  scenario: Scenario,
): CapturedProviderRequest | undefined {
  return requests.find((request) => request.path === scenario.expectedEgressPath);
}

function expectGrokEgress(request: CapturedProviderRequest | undefined, scenario: Scenario): void {
  expect(request, scenario.id).toBeDefined();
  if (!request) {
    return;
  }
  expect(request.method, scenario.id).toBe("POST");
  // OAuth Bearer owns auth.
  expect(readHeader(request.headers, "authorization"), scenario.id).toBe(
    `Bearer ${scenario.accessToken}`,
  );
  // Versioned client identity headers: the proxy rejects unversioned agents (426).
  expect(readHeader(request.headers, "x-xai-token-auth"), scenario.id).toBe("xai-grok-cli");
  expect(readHeader(request.headers, "user-agent"), scenario.id).toContain("grok-shell/");
  expect(readHeader(request.headers, "x-grok-client-mode"), scenario.id).toBe("headless");
  const body = request.bodyJson as { model?: unknown };
  expect(body.model, scenario.id).toBe(scenario.modelId);
}

async function expectSucceededActivity(fixture: Fixture): Promise<void> {
  const scenarios = [nonStreamingScenario, streamingScenario, responsesScenario];
  const expected = scenarios.map((scenario) => ({
    http_status: 200,
    model_id: scenario.modelId,
    protocol: scenario.protocol,
    provider_key: "grok",
    request_id: scenario.requestId,
    status: "succeeded",
  }));

  await expect
    .poll(
      async () => {
        const result = await fixture.query<{
          http_status: number;
          model_id: string;
          protocol: string;
          provider_key: string;
          request_id: string;
          status: string;
        }>(
          `select request_activity.request_id,
                  request_activity.protocol,
                  request_activity.status,
                  request_activity.http_status,
                  providers.provider_key,
                  provider_models.model_id
           from request_activity
           join providers on providers.id = request_activity.provider_id
           join provider_models on provider_models.id = request_activity.provider_model_id
           where request_activity.request_id = any($1::text[])
           order by array_position($1::text[], request_activity.request_id)`,
          [scenarios.map((scenario) => scenario.requestId)],
        );
        return result.rows;
      },
      { timeout: 5_000 },
    )
    .toEqual(expected);
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(" ") : value;
}
