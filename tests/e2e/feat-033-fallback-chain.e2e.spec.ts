import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import {
  buildFallbackAttemptCandidates,
  executeFallbackChain,
  type FallbackChainCandidate,
} from "../../apps/gateway/src/fallback-chain";
import { selectRouteCandidate } from "../../apps/gateway/src/route-engine";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

test("first-byte failure falls back and records failed attempt", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_fallback_chain_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedFallbackRoute(fixture, {
      failedBaseUrl: `${server.url}/v1?mode=first-byte-failure`,
      successfulBaseUrl: `${server.url}/v1`,
    });
    const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
    const routePolicy = snapshot.routePolicies.find(
      (candidate) => candidate.virtualModelName === "fallback-coding",
    );
    if (!routePolicy) {
      throw new Error("Fallback route policy was not loaded.");
    }

    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      snapshot,
      virtualModelName: "fallback-coding",
    });
    const attempts = buildFallbackAttemptCandidates({
      routePolicy,
      selectedProviderModelId: routeDecision.providerModelId,
    }).map((candidate): FallbackChainCandidate => {
      const provider = seeded.providersById.get(candidate.providerId);
      if (!provider) {
        throw new Error(`Provider ${candidate.providerId} was not seeded.`);
      }

      return {
        ...candidate,
        apiKey: "provider-key",
        baseUrl: provider.baseUrl,
      };
    });

    const result = await executeFallbackChain({
      candidates: attempts,
      databaseUrl: fixture.databaseUrl,
      request: {
        messages: [{ content: "hello", role: "user" }],
        stream: false,
      },
      requestActivityId: seeded.requestActivityId,
    });

    expect(result.selectedCandidate.providerModelId).toBe(seeded.successfulProviderModelId);
    expect(result.result).toMatchObject({
      body: {
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      },
      ok: true,
    });
    expect(server.requests.map((request) => request.mode)).toEqual(["first-byte-failure", "json"]);
    await expectFallbackEvents(fixture, [
      {
        attempt_order: 1,
        error_code: "provider_request_failed",
        failed_before_first_byte: true,
        provider_model_id: seeded.failedProviderModelId,
        status: "failed",
      },
      {
        attempt_order: 2,
        error_code: null,
        failed_before_first_byte: false,
        provider_model_id: seeded.successfulProviderModelId,
        status: "succeeded",
      },
    ]);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type SeededFallbackRoute = {
  failedProviderModelId: string;
  providersById: Map<string, { baseUrl: string }>;
  requestActivityId: string;
  successfulProviderModelId: string;
};

type FallbackEventRow = {
  attempt_order: number;
  error_code: string | null;
  failed_before_first_byte: boolean;
  provider_model_id: string;
  status: string;
};

async function seedFallbackRoute(
  fixture: Fixture,
  input: { failedBaseUrl: string; successfulBaseUrl: string },
): Promise<SeededFallbackRoute> {
  const failedProviderId = randomUUID();
  const successfulProviderId = randomUUID();
  const failedProviderModelId = randomUUID();
  const successfulProviderModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const requestActivityId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'failed-openai', 'Failed OpenAI', $2, true),
             ($3, 'api_key', 'successful-openai', 'Successful OpenAI', $4, true)
    `,
    [failedProviderId, input.failedBaseUrl, successfulProviderId, input.successfulBaseUrl],
  );
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        context_window,
        supports_streaming,
        supports_tools,
        availability
      )
      values ($1, $2, 'primary-model', 'Primary Model', 128000, true, true, 'available'),
             ($3, $4, 'fallback-model', 'Fallback Model', 128000, true, true, 'available')
    `,
    [failedProviderModelId, failedProviderId, successfulProviderModelId, successfulProviderId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'fallback-coding', 'Fallback Coding', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order
      )
      values ($1, $2, $3, 1),
             ($4, $2, $5, 2)
    `,
    [randomUUID(), routePolicyId, failedProviderModelId, randomUUID(), successfulProviderModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Fallback Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_test', key_hash = $3, default_virtual_model_id = $4, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, `hash_${randomUUID()}`, virtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        route_policy_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        route_reason,
        status
      )
      values ($1, $2, $3, $4, $5, 'llmi_test', 'chat_completions', 'fallback-coding', false, $6, 'started')
    `,
    [
      requestActivityId,
      `req_${randomUUID()}`,
      agentApiKeyId,
      virtualModelId,
      routePolicyId,
      JSON.stringify({ strategy: "fixed" }),
    ],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Fallback route config')",
  );

  return {
    failedProviderModelId,
    providersById: new Map([
      [failedProviderId, { baseUrl: input.failedBaseUrl }],
      [successfulProviderId, { baseUrl: input.successfulBaseUrl }],
    ]),
    requestActivityId,
    successfulProviderModelId,
  };
}

async function expectFallbackEvents(
  fixture: Fixture,
  expectedRows: FallbackEventRow[],
): Promise<void> {
  const result = await fixture.query<FallbackEventRow>(
    `
      select provider_model_id::text,
             attempt_order,
             status,
             error_code,
             failed_before_first_byte
      from fallback_events
      order by attempt_order
    `,
  );
  expect(result.rows).toEqual(expectedRows);
}
