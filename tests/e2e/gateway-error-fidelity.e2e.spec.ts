import { randomUUID } from "node:crypto";
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

const agentApiKey = "llmi_gateway_error_fidelity_key_094";

test("gateway passes through non-retryable provider 4xx status and sanitized message", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_error_4xx_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=bad-request`,
      virtualModelName: "vm-provider-4xx",
    });

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
          model: "vm-provider-4xx",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("provider_rejected_request");
      expect(body.error.message).toContain("context length exceeded");
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway skips a fallback candidate with missing credentials", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_error_missing_key_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      agentApiKey: `${agentApiKey}_fallback`,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-missing-key-fallback",
    });
    await seedMissingCredentialCandidate(fixture, seeded.routePolicyId, fakeProvider.url);

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
          model: "vm-missing-key-fallback",
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}_fallback`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(fakeProvider.requests).toHaveLength(1);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

async function seedMissingCredentialCandidate(
  fixture: {
    query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
  },
  routePolicyId: string,
  providerBaseUrl: string,
): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  await fixture.query(
    "update route_policy_candidates set candidate_order = 2 where route_policy_id = $1",
    [routePolicyId],
  );
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
      values ($1, 'api_key', 'openai', null, 'OpenAI Missing Key', $2, true)
    `,
    [providerId, providerBaseUrl],
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
      values ($1, $2, 'fake-model', 'Fake Model Missing Key', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
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
