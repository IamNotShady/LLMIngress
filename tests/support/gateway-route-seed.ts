import { randomUUID } from "node:crypto";
import type { RouteEndpointProtocol, RoutePolicyStrategy } from "@llmingress/domain";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { buildGatewayApiKeyHash } from "../../packages/gateway-runtime/src/gateway-auth";

export type QueryableFixture = {
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
};

export type SeedOpenAIGatewayRouteInput = {
  apiKey: string;
  endpointProtocol?: RouteEndpointProtocol;
  fixture: QueryableFixture;
  limitsEnabled?: boolean;
  encryptionKey?: string;
  modelId?: string;
  providerApiKey?: string;
  providerBaseUrl: string;
  /** Tags for the seeded first candidate; only a tag strategy reads them. */
  tags?: readonly string[];
  strategy?: RoutePolicyStrategy;
  virtualModelName: string;
};

export type SeedOpenAIGatewayRouteResult = {
  apiKeyId: string;
  providerId: string;
  providerModelId: string;
  routePolicyId: string;
  virtualModelId: string;
};

export type SeedGatewayRouteCandidateInput = {
  candidateOrder: number;
  contextWindow?: number;
  encryptionKey?: string;
  fixture: QueryableFixture;
  maxOutputTokens?: number;
  modelId?: string;
  providerApiKey?: string;
  providerBaseUrl: string;
  providerDisplayName?: string;
  routePolicyId: string;
  tags?: readonly string[];
};

export type SeedGatewayRouteCandidateResult = {
  providerId: string;
  providerModelId: string;
};

export async function seedOpenAIGatewayRoute(
  input: SeedOpenAIGatewayRouteInput,
): Promise<SeedOpenAIGatewayRouteResult> {
  const apiKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const providerApiKey = input.providerApiKey ?? "fake-provider-key";
  const encrypted = createSecretEncryption({
    kind: "inline",
    value: input.encryptionKey ?? "test-master-key",
  }).encrypt(providerApiKey);

  await input.fixture.query(
    `
      insert into api_keys (
        id,
        name,
        key_prefix,
        key_hash,
        enabled,
        limits_enabled
      )
      values ($1, 'Gateway E2E ApiKey', $2, $3, true, $4)
    `,
    [
      apiKeyId,
      input.apiKey.slice(0, 12),
      buildGatewayApiKeyHash(input.apiKey),
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
  await input.fixture.query("update api_keys set default_virtual_model_id = $2 where id = $1", [
    apiKeyId,
    virtualModelId,
  ]);
  await input.fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values ($1, $2, $3, $4)",
    [
      routePolicyId,
      virtualModelId,
      input.strategy ?? "fixed",
      input.endpointProtocol ?? "chat_completions",
    ],
  );
  await input.fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order,
        tags
      )
      values ($1, $2, $3, 1, $4::text[])
    `,
    [randomUUID(), routePolicyId, providerModelId, input.tags ?? []],
  );
  await input.fixture.query(
    "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
    [apiKeyId, virtualModelId],
  );
  await input.fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Gateway E2E config') on conflict (version) do nothing",
  );

  return { apiKeyId, providerId, providerModelId, routePolicyId, virtualModelId };
}

/**
 * Adds one more candidate to an existing policy, each behind its own provider so
 * a test can tell which upstream a request reached.
 */
export async function seedGatewayRouteCandidate(
  input: SeedGatewayRouteCandidateInput,
): Promise<SeedGatewayRouteCandidateResult> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const providerApiKey = input.providerApiKey ?? "fake-provider-key";
  const encrypted = createSecretEncryption({
    kind: "inline",
    value: input.encryptionKey ?? "test-master-key",
  }).encrypt(providerApiKey);

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
      values ($1, 'api_key', 'openai', null, $2, $3, true)
    `,
    [
      providerId,
      input.providerDisplayName ?? `OpenAI ${input.candidateOrder}`,
      input.providerBaseUrl,
    ],
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
      values ($1, $2, $3, 'Fake Model', array['text']::text[], array['text']::text[], $4, $5, true, true, false, 'available')
    `,
    [
      providerModelId,
      providerId,
      input.modelId ?? `fake-model-${input.candidateOrder}`,
      input.contextWindow ?? 128000,
      input.maxOutputTokens ?? 8192,
    ],
  );
  await input.fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order,
        tags
      )
      values ($1, $2, $3, $4, $5::text[])
    `,
    [randomUUID(), input.routePolicyId, providerModelId, input.candidateOrder, input.tags ?? []],
  );

  return { providerId, providerModelId };
}
