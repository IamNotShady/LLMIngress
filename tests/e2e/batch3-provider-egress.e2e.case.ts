import { randomUUID } from "node:crypto";
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

const encryptionKey = "test-master-key";
const apiKey = "llmi_v1_batch3_provider_egress_key_001";

// Batch 3 egress: the four paste-key providers are OpenAI chat_completions
// api_key providers on the chat face (command_code also has a messages face,
// exercised separately by the provider-coverage smoke). Each must route egress
// to base + /chat/completions with a Bearer credential, against a mocked
// upstream. Feature A seeds command_code + nous; Feature B appends cline_pass +
// byteplus_coding.
type EgressScenario = {
  baseUrlSuffix: string;
  displayName: string;
  expectedProviderPath: string;
  id: string;
  modelDisplayName: string;
  modelId: string;
  providerApiKey: string;
  providerKey: string;
  providerTemplateId: string;
  requestId: string;
  virtualModelDisplayName: string;
  virtualModelName: string;
};

const scenarios: EgressScenario[] = [
  {
    baseUrlSuffix: "/command_code/provider/v1",
    displayName: "Command Code",
    expectedProviderPath: "/command_code/provider/v1/chat/completions",
    id: "command_code",
    modelDisplayName: "Claude Sonnet 4.5",
    modelId: "claude-sonnet-4-5",
    providerApiKey: "user_command-code-egress-0000000000000000000001",
    providerKey: "command_code",
    providerTemplateId: "command_code",
    requestId: "req_batch3_command_code_001",
    virtualModelDisplayName: "Batch3 Command Code",
    virtualModelName: "batch3-command-code",
  },
  {
    baseUrlSuffix: "/nous/v1",
    displayName: "NousResearch",
    expectedProviderPath: "/nous/v1/chat/completions",
    id: "nous",
    modelDisplayName: "Hermes 4 405B",
    modelId: "hermes-4-405b",
    providerApiKey: "sk-nous-egress-001",
    providerKey: "nous",
    providerTemplateId: "nous",
    requestId: "req_batch3_nous_001",
    virtualModelDisplayName: "Batch3 Nous",
    virtualModelName: "batch3-nous",
  },
];

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;
type CapturedProviderRequest = Awaited<
  ReturnType<typeof createFakeProviderServer>
>["requests"][number];

test("batch 3 paste-key providers route chat_completions egress to a mocked upstream", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_batch3_egress_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedRoutes(fixture, fakeProvider.url);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      for (const scenario of scenarios) {
        const response = await requestScenario(baseUrl, scenario);
        expect(response.status, scenario.id).toBe(200);
        const body = await response.json();
        expect(body, scenario.id).toMatchObject({
          choices: [{ message: { content: "fake provider response", role: "assistant" } }],
        });
      }

      expect(fakeProvider.requests).toHaveLength(scenarios.length);
      for (const [index, scenario] of scenarios.entries()) {
        expectCapturedRequest(fakeProvider.requests[index], scenario);
      }
      await expectRequestActivityRows(fixture);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

async function seedRoutes(fixture: Fixture, fakeProviderUrl: string): Promise<void> {
  const apiKeyId = randomUUID();
  const seedApiKeyId = randomUUID();
  const seededVirtualModelIds: string[] = [];

  await fixture.query(
    "insert into api_keys (id, name, key_prefix, key_hash, enabled) values ($1, 'Batch3 Egress ApiKey', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true)",
    [seedApiKeyId],
  );

  for (const scenario of scenarios) {
    const providerId = randomUUID();
    const providerModelId = randomUUID();
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();
    const encrypted = createSecretEncryption({ kind: "inline", value: encryptionKey }).encrypt(
      scenario.providerApiKey,
    );

    seededVirtualModelIds.push(virtualModelId);
    await fixture.query(
      `insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled)
       values ($1, 'api_key', $2, $3, $4, $5, true)`,
      [
        providerId,
        scenario.providerKey,
        scenario.providerTemplateId,
        scenario.displayName,
        `${fakeProviderUrl}${scenario.baseUrlSuffix}`,
      ],
    );
    await fixture.query(
      `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
       values ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        providerId,
        scenario.providerApiKey.slice(0, 12),
        JSON.stringify(encrypted),
        encrypted.keyId,
      ],
    );
    await fixture.query(
      `insert into provider_models (id, provider_id, model_id, display_name, input_modalities, output_modalities, context_window, max_output_tokens, supports_streaming, supports_function_calling, supports_reasoning, availability)
       values ($1, $2, $3, $4, array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')`,
      [providerModelId, providerId, scenario.modelId, scenario.modelDisplayName],
    );
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
      [virtualModelId, scenario.virtualModelName, scenario.virtualModelDisplayName],
    );
    await fixture.query(
      "insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values ($1, $2, 'fixed', 'chat_completions')",
      [routePolicyId, virtualModelId],
    );
    await fixture.query(
      "insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order) values ($1, $2, $3, 1)",
      [randomUUID(), routePolicyId, providerModelId],
    );
  }

  await fixture.query(
    "update api_keys set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2",
    [
      apiKeyId,
      seedApiKeyId,
      apiKey.slice(0, 12),
      buildGatewayApiKeyHash(apiKey),
      seededVirtualModelIds[0],
    ],
  );
  for (const virtualModelId of seededVirtualModelIds) {
    await fixture.query(
      "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
      [apiKeyId, virtualModelId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Batch3 egress config')",
  );
}

async function requestScenario(baseUrl: string, scenario: EgressScenario): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
      model: scenario.virtualModelName,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-request-id": scenario.requestId,
    },
    method: "POST",
  });
}

function expectCapturedRequest(
  request: CapturedProviderRequest | undefined,
  scenario: EgressScenario,
): void {
  expect(request, scenario.id).toMatchObject({
    method: "POST",
    path: scenario.expectedProviderPath,
  });
  expect(request?.bodyJson, scenario.id).toMatchObject({
    messages: [{ content: `hello through ${scenario.id}`, role: "user" }],
    model: scenario.modelId,
    stream: false,
  });
  const authHeader = request?.headers.authorization;
  expect(Array.isArray(authHeader) ? authHeader.join(" ") : authHeader, scenario.id).toBe(
    `Bearer ${scenario.providerApiKey}`,
  );
}

async function expectRequestActivityRows(fixture: Fixture): Promise<void> {
  const expected = scenarios.map((scenario) => ({
    http_status: 200,
    model_id: scenario.modelId,
    protocol: "chat_completions",
    provider_key: scenario.providerKey,
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
