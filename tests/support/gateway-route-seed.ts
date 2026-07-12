import { randomUUID } from "node:crypto";
import type { RouteEndpointProtocol } from "@llmingress/domain";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { buildGatewayAgentApiKeyHash } from "../../packages/gateway-runtime/src/gateway-auth";

export type QueryableFixture = {
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
};

export type SeedOpenAIGatewayRouteInput = {
  agentApiKey: string;
  endpointProtocol?: RouteEndpointProtocol;
  fixture: QueryableFixture;
  limitsEnabled?: boolean;
  masterKey?: string;
  modelId?: string;
  providerApiKey?: string;
  providerBaseUrl: string;
  virtualModelName: string;
};

export type SeedOpenAIGatewayRouteResult = {
  agentId: string;
  providerId: string;
  providerModelId: string;
  routePolicyId: string;
  virtualModelId: string;
};

export async function seedOpenAIGatewayRoute(
  input: SeedOpenAIGatewayRouteInput,
): Promise<SeedOpenAIGatewayRouteResult> {
  const agentId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const providerApiKey = input.providerApiKey ?? "fake-provider-key";
  const encrypted = createSecretEncryption({
    kind: "inline",
    value: input.masterKey ?? "test-master-key",
  }).encrypt(providerApiKey);

  await input.fixture.query(
    `
      insert into agents (
        id,
        name,
        key_prefix,
        key_hash,
        enabled,
        limits_enabled
      )
      values ($1, 'Gateway E2E Agent', $2, $3, true, $4)
    `,
    [
      agentId,
      input.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.agentApiKey),
      input.limitsEnabled ?? false,
    ],
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
      values ($1, 'api_key', 'openai', null, 'OpenAI', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
  await input.fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [
      randomUUID(),
      providerId,
      providerApiKey.slice(0, 12),
      JSON.stringify(encrypted),
      encrypted.keyId,
    ],
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
      values ($1, $2, $3, 'Fake Model', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
    `,
    [providerModelId, providerId, input.modelId ?? "fake-model"],
  );
  await input.fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, $2, 'Gateway E2E VM', true)",
    [virtualModelId, input.virtualModelName],
  );
  await input.fixture.query("update agents set default_virtual_model_id = $2 where id = $1", [
    agentId,
    virtualModelId,
  ]);
  await input.fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values ($1, $2, 'fixed', $3)",
    [routePolicyId, virtualModelId, input.endpointProtocol ?? "chat_completions"],
  );
  await input.fixture.query(
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
  await input.fixture.query(
    "insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)",
    [agentId, virtualModelId],
  );
  await input.fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Gateway E2E config') on conflict (version) do nothing",
  );

  return { agentId, providerId, providerModelId, routePolicyId, virtualModelId };
}
