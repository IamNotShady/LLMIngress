import { randomUUID } from "node:crypto";
import {
  createRoutePolicy,
  normalizeRoutePolicyFormInput,
} from "@llmingress/db/console-route-policies";
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

const agentApiKey = "llmi_virtual_model_capability_contract_key";

test("route policy save rejects incomplete and mismatched provider model capabilities", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_contract_console_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRoutePolicyCapabilityData(fixture);

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: "chat_completions",
          providerModelIds: [seeded.completeModelId, seeded.mismatchedModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).rejects.toMatchObject({
      code: "route_policy_candidate_capability_mismatch",
    });

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: "chat_completions",
          providerModelIds: [seeded.incompleteModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).rejects.toMatchObject({
      code: "route_policy_candidate_capability_incomplete",
    });
  } finally {
    await fixture.dispose();
  }
});

test("gateway rejects requests that exceed the Virtual Model capability contract before provider calls", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_contract_gateway_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: provider.url,
      virtualModelName: "vm-contract-gateway",
    });
    await fixture.query(
      `
        update provider_models
        set input_modalities = array['text']::text[],
            output_modalities = array['text']::text[],
            context_window = 8192,
            max_output_tokens = 1024,
            supports_function_calling = false,
            supports_reasoning = false
      `,
    );

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-contract-gateway",
          tools: [{ function: { name: "lookup" }, type: "function" }],
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: { code: "virtual_model_capability_mismatch" },
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

async function seedRoutePolicyCapabilityData(fixture: Fixture): Promise<{
  completeModelId: string;
  incompleteModelId: string;
  mismatchedModelId: string;
  virtualModelId: string;
}> {
  const providerId = randomUUID();
  const completeModelId = randomUUID();
  const incompleteModelId = randomUUID();
  const mismatchedModelId = randomUUID();
  const virtualModelId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Capability Provider', 'http://provider.test/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'vm-contract-console', 'VM Contract Console', true)",
    [virtualModelId],
  );
  await insertProviderModel(fixture, {
    id: completeModelId,
    maxOutputTokens: 8192,
    providerId,
    supportsReasoning: false,
  });
  await insertProviderModel(fixture, {
    id: mismatchedModelId,
    maxOutputTokens: 4096,
    providerId,
    supportsReasoning: false,
  });
  await insertProviderModel(fixture, {
    id: incompleteModelId,
    maxOutputTokens: null,
    providerId,
    supportsReasoning: false,
  });

  return { completeModelId, incompleteModelId, mismatchedModelId, virtualModelId };
}

async function insertProviderModel(
  fixture: Fixture,
  input: {
    id: string;
    maxOutputTokens: number | null;
    providerId: string;
    supportsReasoning: boolean | null;
  },
): Promise<void> {
  await fixture.query(
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
      values ($1, $2, $3, 'Capability Model', array['text']::text[], array['text']::text[], 128000, $4, true, true, $5, 'available')
    `,
    [
      input.id,
      input.providerId,
      `model-${input.id.slice(0, 8)}`,
      input.maxOutputTokens,
      input.supportsReasoning,
    ],
  );
}
