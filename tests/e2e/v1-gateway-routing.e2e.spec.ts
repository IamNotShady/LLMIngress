import { randomUUID } from "node:crypto";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { buildGatewayAgentApiKeyHash } from "../../packages/gateway-runtime/src/gateway-auth";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import {
  buildV1ProviderCoverageSmokePlan,
  type V1ProviderCoverageScenario,
} from "../support/v1-provider-coverage-smoke";

const masterKey = "test-master-key";
const agentApiKey = "llmi_v1_provider_coverage_smoke_key_094";

test("v1 provider coverage smoke routes core providers local providers and validates long tail templates available", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_v1_provider_smoke_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();
  const plan = buildV1ProviderCoverageSmokePlan(fakeProvider.url);

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedV1ProviderCoverageRoutes(fixture, plan.providerScenarios);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      for (const scenario of plan.providerScenarios) {
        const response = await requestScenario(baseUrl, scenario);
        expect(response.status, scenario.id).toBe(200);
        await expectScenarioResponse(response, scenario);
      }

      expect(fakeProvider.requests).toHaveLength(plan.providerScenarios.length);
      for (const [index, scenario] of plan.providerScenarios.entries()) {
        expectCapturedProviderRequest(fakeProvider.requests[index], scenario);
      }
      await expectRequestActivityRows(fixture, plan.providerScenarios);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type CapturedProviderRequest = Awaited<
  ReturnType<typeof createFakeProviderServer>
>["requests"][number];

async function seedV1ProviderCoverageRoutes(
  fixture: Fixture,
  scenarios: readonly V1ProviderCoverageScenario[],
): Promise<void> {
  const agentId = randomUUID();
  const seedAgentId = randomUUID();
  const encryptedKeys = scenarios.map((scenario) =>
    createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(scenario.providerApiKey),
  );
  const seededVirtualModelIds: string[] = [];

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'V1 Provider Smoke Agent', 'coding', true)",
    [seedAgentId],
  );

  for (const [index, scenario] of scenarios.entries()) {
    const providerId = randomUUID();
    const providerModelId = randomUUID();
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();
    const encrypted = encryptedKeys[index];

    seededVirtualModelIds.push(virtualModelId);
    await fixture.query(
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
        values ($1, $2, $3, $4, $5, $6, true)
      `,
      [
        providerId,
        scenario.providerType,
        scenario.providerKey,
        scenario.providerTemplateId,
        scenario.displayName,
        scenario.baseUrl,
      ],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, $3, $4, $5)
      `,
      [
        randomUUID(),
        providerId,
        scenario.providerApiKey.slice(0, 12),
        JSON.stringify(encrypted),
        encrypted.keyId,
      ],
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
          supports_function_calling,
          availability
        )
        values ($1, $2, $3, $4, 128000, true, true, 'available')
      `,
      [providerModelId, providerId, scenario.modelId, scenario.modelDisplayName],
    );
    await fixture.query(
      `
        insert into virtual_models (id, name, description, enabled)
        values ($1, $2, $3, true)
      `,
      [virtualModelId, scenario.virtualModelName, scenario.virtualModelDisplayName],
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
        values ($1, $2, $3, 1)
      `,
      [randomUUID(), routePolicyId, providerModelId],
    );
  }

  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentId,
      seedAgentId,
      agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(agentApiKey),
      seededVirtualModelIds[0],
    ],
  );

  for (const virtualModelId of seededVirtualModelIds) {
    await fixture.query(
      `
        insert into agent_virtual_models (agent_id, virtual_model_id)
        values ($1, $2)
      `,
      [agentId, virtualModelId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'V1 provider coverage smoke config')",
  );
}

async function requestScenario(
  baseUrl: string,
  scenario: V1ProviderCoverageScenario,
): Promise<Response> {
  const endpoint =
    scenario.endpoint === "messages" ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;
  const body =
    scenario.endpoint === "messages"
      ? {
          max_tokens: 64,
          messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
          model: scenario.virtualModelName,
          stream: false,
        }
      : {
          messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
          model: scenario.virtualModelName,
          stream: false,
        };

  return fetch(endpoint, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${agentApiKey}`,
      "content-type": "application/json",
      "x-request-id": scenario.requestId,
    },
    method: "POST",
  });
}

async function expectScenarioResponse(
  response: Response,
  scenario: V1ProviderCoverageScenario,
): Promise<void> {
  const body = await response.json();

  if (scenario.endpoint === "messages") {
    expect(body, scenario.id).toMatchObject({
      content: [{ text: "fake provider response", type: "text" }],
      id: "fake-provider-message",
      role: "assistant",
      type: "message",
    });
    return;
  }

  expect(body, scenario.id).toMatchObject({
    choices: [
      {
        message: {
          content: "fake provider response",
          role: "assistant",
        },
      },
    ],
  });
}

function expectCapturedProviderRequest(
  request: CapturedProviderRequest | undefined,
  scenario: V1ProviderCoverageScenario,
): void {
  expect(request, scenario.id).toMatchObject({
    method: "POST",
    path: scenario.expectedProviderPath,
  });

  if (scenario.endpoint === "messages") {
    expect(request?.bodyJson, scenario.id).toMatchObject({
      max_tokens: 64,
      messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
      model: scenario.modelId,
      stream: false,
    });
  } else {
    expect(request?.bodyJson, scenario.id).toMatchObject({
      messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
      model: scenario.modelId,
      stream: false,
    });
  }

  const authHeader = readHeader(request, scenario.expectedAuthHeader);
  if (scenario.providerType === "local") {
    expect(authHeader, scenario.id).toBeUndefined();
  } else {
    expect(authHeader, scenario.id).toBe(scenario.expectedAuthValue);
  }
  if (scenario.id === "openrouter") {
    expect(readHeader(request, "http-referer"), scenario.id).toBe("https://llmingress.local");
    expect(readHeader(request, "x-openrouter-title"), scenario.id).toBe("LLMIngress");
  }
}

async function expectRequestActivityRows(
  fixture: Fixture,
  scenarios: readonly V1ProviderCoverageScenario[],
): Promise<void> {
  const result = await fixture.query<{
    http_status: number;
    model: string;
    model_id: string;
    protocol: string;
    provider_key: string;
    request_id: string;
    status: string;
  }>(
    `
      select request_activity.request_id,
             request_activity.protocol,
             request_activity.model,
             request_activity.status,
             request_activity.http_status,
             providers.provider_key,
             provider_models.model_id
      from request_activity
      join providers on providers.id = request_activity.provider_id
      join provider_models on provider_models.id = request_activity.provider_model_id
      where request_activity.request_id = any($1::text[])
      order by array_position($1::text[], request_activity.request_id)
    `,
    [scenarios.map((scenario) => scenario.requestId)],
  );

  expect(result.rows).toEqual(
    scenarios.map((scenario) => ({
      http_status: 200,
      model: scenario.virtualModelName,
      model_id: scenario.modelId,
      protocol: scenario.endpoint,
      provider_key: scenario.providerKey,
      request_id: scenario.requestId,
      status: "succeeded",
    })),
  );
}

function readHeader(
  request: CapturedProviderRequest | undefined,
  header: string,
): string | undefined {
  const value = request?.headers[header];
  return Array.isArray(value) ? value.join(" ") : value;
}
