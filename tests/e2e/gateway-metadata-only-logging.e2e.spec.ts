import { randomUUID } from "node:crypto";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer, type FakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const promptMarker = "E2E_PROMPT_MARKER_DO_NOT_LOG";
const toolArgumentMarker = "E2E_TOOL_ARGUMENT_MARKER_DO_NOT_LOG";
const testKeyMarker = "E2E_TEST_KEY_MARKER_DO_NOT_LOG";
const jsonAgentApiKey = "llmi_json_metadata_key";
const streamAgentApiKey = "llmi_stream_metadata_key";
const errorAgentApiKey = "llmi_error_metadata_key";
const fallbackAgentApiKey = "llmi_fallback_metadata_key";

test("Gateway stdout logs omit prompt, tool arguments, and test keys across JSON, streaming, error, and fallback paths", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_metadata_logging_${randomUUID().replaceAll("-", "_")}`,
  });
  const providers: FakeProviderServer[] = [];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const jsonProvider = await createProvider(providers);
    const streamProvider = await createProvider(providers);
    const errorProvider = await createProvider(providers);
    const fallbackFailingProvider = await createProvider(providers);
    const fallbackSucceedingProvider = await createProvider(providers);

    await seedOpenAIGatewayRoute({
      agentApiKey: jsonAgentApiKey,
      fixture,
      providerBaseUrl: jsonProvider.url,
      virtualModelName: "vm-metadata-json",
    });
    await seedOpenAIGatewayRoute({
      agentApiKey: streamAgentApiKey,
      fixture,
      providerBaseUrl: `${streamProvider.url}?mode=stream&stream_end_ms=20`,
      virtualModelName: "vm-metadata-stream",
    });
    await seedOpenAIGatewayRoute({
      agentApiKey: errorAgentApiKey,
      fixture,
      providerBaseUrl: `${errorProvider.url}?mode=bad-request`,
      virtualModelName: "vm-metadata-error",
    });
    const fallbackRoute = await seedOpenAIGatewayRoute({
      agentApiKey: fallbackAgentApiKey,
      fixture,
      providerBaseUrl: `${fallbackFailingProvider.url}?mode=rate-limit`,
      virtualModelName: "vm-metadata-fallback",
    });
    await seedFallbackProviderCandidate({
      fixture,
      providerBaseUrl: fallbackSucceedingProvider.url,
      routePolicyId: fallbackRoute.routePolicyId,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      env: { LOG_LEVEL: "info" },
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const jsonResponse = await postChatCompletion({
        agentApiKey: jsonAgentApiKey,
        baseUrl,
        model: "vm-metadata-json",
        stream: false,
      });
      expect(jsonResponse.status).toBe(200);
      await jsonResponse.text();

      const streamResponse = await postChatCompletion({
        agentApiKey: streamAgentApiKey,
        baseUrl,
        model: "vm-metadata-stream",
        stream: true,
      });
      expect(streamResponse.status).toBe(200);
      expect(await streamResponse.text()).toContain("fake");

      const errorResponse = await postChatCompletion({
        agentApiKey: errorAgentApiKey,
        baseUrl,
        model: "vm-metadata-error",
        stream: false,
      });
      expect(errorResponse.status).toBe(400);
      await errorResponse.text();

      const fallbackResponse = await postChatCompletion({
        agentApiKey: fallbackAgentApiKey,
        baseUrl,
        model: "vm-metadata-fallback",
        stream: false,
      });
      expect(fallbackResponse.status).toBe(200);
      await fallbackResponse.text();

      await expect
        .poll(() => gateway.stdout.join("") + gateway.stderr.join(""))
        .toContain("gateway agent request");
    } finally {
      await stopGatewayProcess(gateway);
    }

    const logs = gateway.stdout.join("") + gateway.stderr.join("");
    expect(logs).toContain("vm-metadata-json");
    expect(logs).toContain("vm-metadata-stream");
    expect(logs).toContain("vm-metadata-error");
    expect(logs).toContain("vm-metadata-fallback");
    expect(logs).not.toContain(promptMarker);
    expect(logs).not.toContain(toolArgumentMarker);
    expect(logs).not.toContain(testKeyMarker);
  } finally {
    await Promise.all(providers.map((provider) => provider.close()));
    await fixture.dispose();
  }
});

async function createProvider(providers: FakeProviderServer[]): Promise<FakeProviderServer> {
  const provider = await createFakeProviderServer();
  providers.push(provider);
  return provider;
}

async function seedFallbackProviderCandidate(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  providerBaseUrl: string;
  routePolicyId: string;
}): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: "test-master-key" }).encrypt(
    "metadata-fallback-provider-key",
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
      values ($1, 'api_key', 'openai', null, 'OpenAI Metadata Fallback', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
  await input.fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [randomUUID(), providerId, "metadata-fb", JSON.stringify(encrypted), encrypted.keyId],
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
      values ($1, $2, 'fake-model', 'Fake Metadata Fallback Model', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
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
  agentApiKey: string;
  baseUrl: string;
  model: string;
  stream: boolean;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: `ping ${promptMarker}`, role: "user" }],
      model: input.model,
      stream: input.stream,
      tools: [
        {
          function: {
            description: "leak detector",
            name: "leak_detector",
            parameters: {
              properties: {
                marker: { const: toolArgumentMarker, type: "string" },
              },
              type: "object",
            },
          },
          type: "function",
        },
      ],
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
      "x-api-key": testKeyMarker,
    },
    method: "POST",
  });
}
