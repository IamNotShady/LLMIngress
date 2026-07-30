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

// MiniMax Coding Plan (Feature B) is the first subscription-type Anthropic
// messages egress: a plain OAuth Bearer + the injected identity system block,
// no claude-cli header impersonation. Two scenarios against one mocked upstream:
//   1. non-streaming, with a per-token resource_url that outranks the registry
//      base (per-key override);
//   2. streaming, no override, so egress lands on the provider base.
const encryptionKey = "test-master-key";
const apiKey = "llmi_v1_minimax_coding_egress_key_001";

const identitySystemText = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const nonStreamingScenario = {
  accessToken: "minimax-oauth-token-non-streaming",
  displayName: "MiniMax Coding Plan (per-key base)",
  id: "minimax_non_streaming",
  modelDisplayName: "MiniMax M2",
  modelId: "MiniMax-M2",
  providerBaseUrlSuffix: "/registry-base/anthropic/v1",
  // The token's resource_url points at a different path than the registry base;
  // egress must prefer it.
  resourceUrlSuffix: "/token-base/anthropic/v1",
  expectedEgressPath: "/token-base/anthropic/v1/messages",
  requestId: "req_minimax_non_streaming_001",
  virtualModelName: "minimax-coding-non-streaming",
} as const;

const streamingScenario = {
  accessToken: "minimax-oauth-token-streaming",
  displayName: "MiniMax Coding Plan (streaming)",
  id: "minimax_streaming",
  modelDisplayName: "MiniMax M2 Stream",
  modelId: "MiniMax-M2-stream",
  // ?mode=stream drives the fake upstream's SSE response; joinUrl preserves the
  // query while appending /messages to the path.
  providerBaseUrlSuffix: "/registry-base-stream/anthropic/v1?mode=stream&stream_end_ms=20",
  resourceUrlSuffix: null,
  expectedEgressPath: "/registry-base-stream/anthropic/v1/messages",
  requestId: "req_minimax_streaming_001",
  virtualModelName: "minimax-coding-streaming",
} as const;

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;
type CapturedProviderRequest = Awaited<
  ReturnType<typeof createFakeProviderServer>
>["requests"][number];

test("minimax_coding routes subscription messages egress with a Bearer, identity block, and per-token base", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_minimax_egress_${randomUUID().replaceAll("-", "_")}`,
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
    await seedApiKey(fixture, [nonStreamingVmId, streamingVmId]);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const nonStreamingResponse = await postMessages(baseUrl, nonStreamingScenario, false);
      expect(nonStreamingResponse.status).toBe(200);
      const nonStreamingBody = await nonStreamingResponse.json();
      expect(nonStreamingBody).toMatchObject({ type: "message" });

      const streamingResponse = await postMessages(baseUrl, streamingScenario, true);
      expect(streamingResponse.status).toBe(200);
      expect(await streamingResponse.text()).toContain("fake");

      const nonStreamingEgress = findEgressRequest(fakeProvider.requests, nonStreamingScenario);
      expectCleanSubscriptionEgress(nonStreamingEgress, nonStreamingScenario);

      const streamingEgress = findEgressRequest(fakeProvider.requests, streamingScenario);
      expectCleanSubscriptionEgress(streamingEgress, streamingScenario);
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
  input: {
    fakeProviderUrl: string;
    scenario: typeof nonStreamingScenario | typeof streamingScenario;
  },
): Promise<string> {
  const { fakeProviderUrl, scenario } = input;
  const providerId = randomUUID();
  const oauthId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

  const blob: Record<string, unknown> = {
    accessToken: scenario.accessToken,
    expiresAt: null,
    refreshToken: null,
    scopes: [],
    tokenType: "Bearer",
  };
  if (scenario.resourceUrlSuffix) {
    blob.resourceUrl = `${fakeProviderUrl}${scenario.resourceUrlSuffix}`;
  }
  const encrypted = createSecretEncryption({ kind: "inline", value: encryptionKey }).encrypt(
    JSON.stringify(blob),
  );

  await fixture.query(
    `insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled)
     values ($1, 'subscription', 'minimax_coding', 'minimax_coding', $2, $3, true)`,
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
    "insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values ($1, $2, 'fixed', 'messages')",
    [routePolicyId, virtualModelId],
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
     values ($1, 'MiniMax Egress ApiKey', $2, $3, $4, true)`,
    [apiKeyId, apiKey.slice(0, 12), buildGatewayApiKeyHash(apiKey), virtualModelIds[0]],
  );
  for (const virtualModelId of virtualModelIds) {
    await fixture.query(
      "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
      [apiKeyId, virtualModelId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'MiniMax egress config')",
  );
}

async function postMessages(
  baseUrl: string,
  scenario: typeof nonStreamingScenario | typeof streamingScenario,
  stream: boolean,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    body: JSON.stringify({
      max_tokens: 128,
      messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
      model: scenario.virtualModelName,
      stream,
      system: "Use terse replies.",
    }),
    headers: {
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-request-id": scenario.requestId,
    },
    method: "POST",
  });
}

function findEgressRequest(
  requests: CapturedProviderRequest[],
  scenario: typeof nonStreamingScenario | typeof streamingScenario,
): CapturedProviderRequest | undefined {
  return requests.find((request) => request.path === scenario.expectedEgressPath);
}

function expectCleanSubscriptionEgress(
  request: CapturedProviderRequest | undefined,
  scenario: typeof nonStreamingScenario | typeof streamingScenario,
): void {
  expect(request, scenario.id).toBeDefined();
  if (!request) {
    return;
  }
  expect(request.method, scenario.id).toBe("POST");
  // Bearer OAuth token owns auth; no x-api-key leaks alongside it.
  expect(readHeader(request.headers, "authorization"), scenario.id).toBe(
    `Bearer ${scenario.accessToken}`,
  );
  expect(readHeader(request.headers, "x-api-key"), scenario.id).toBeUndefined();
  // No claude-cli impersonation: no anthropic-beta, no stainless, no user-agent
  // masquerade — the Anthropic version header is fine.
  expect(readHeader(request.headers, "anthropic-beta"), scenario.id).toBeUndefined();
  expect(readHeader(request.headers, "anthropic-version"), scenario.id).toBe("2023-06-01");
  expect(
    Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-stainless")),
    scenario.id,
  ).toBe(false);
  expect(
    readHeader(request.headers, "user-agent")?.includes("claude-cli"),
    scenario.id,
  ).toBeFalsy();
  // The identity system block is injected verbatim ahead of the caller prompt.
  const body = request.bodyJson as { model?: unknown; system?: unknown };
  expect(body.system, scenario.id).toEqual([
    { text: identitySystemText, type: "text" },
    { text: "Use terse replies.", type: "text" },
  ]);
  expect(body.model, scenario.id).toBe(scenario.modelId);
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(" ") : value;
}
