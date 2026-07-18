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

const apiKey = "llmi_gateway_error_fidelity_key_094";

test("gateway passes through non-retryable provider 4xx body and status", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_error_4xx_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=bad-request`,
      virtualModelName: "vm-provider-4xx",
    });
    const responsesApiKey = "llmi_resp_error_fidelity_key_094";
    await seedOpenAIGatewayRoute({
      apiKey: responsesApiKey,
      endpointProtocol: "responses",
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=bad-request`,
      virtualModelName: "vm-provider-responses-4xx",
    });
    await fixture.query(
      "update provider_models set output_modalities = array['text', 'embedding']::text[]",
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
          model: "vm-provider-4xx",
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(response.headers.get("x-request-id")).toBe("fake-provider-request");
      expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("99");
      expect(body).toEqual({
        error: {
          code: "context_length_exceeded",
          message: "context length exceeded by fake provider",
        },
      });

      const streamingResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-provider-4xx",
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const streamingBody = await streamingResponse.json();

      expect(streamingResponse.status).toBe(400);
      expect(streamingResponse.headers.get("x-request-id")).toBe("fake-provider-request");
      expect(streamingResponse.headers.get("x-ratelimit-remaining-requests")).toBe("99");
      expect(streamingBody).toEqual(body);

      const responsesResponse = await fetch(`${baseUrl}/v1/responses`, {
        body: JSON.stringify({
          input: [{ content: [{ text: "ping", type: "input_text" }], role: "user" }],
          model: "vm-provider-responses-4xx",
        }),
        headers: {
          authorization: `Bearer ${responsesApiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const responsesBody = await responsesResponse.json();

      expect(responsesResponse.status).toBe(400);
      expect(responsesResponse.headers.get("x-request-id")).toBe("fake-provider-request");
      expect(responsesResponse.headers.get("x-ratelimit-remaining-requests")).toBe("99");
      expect(responsesBody).toEqual(body);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway messages endpoint passes through non-retryable provider 4xx body and status", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_error_messages_4xx_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_messages`,
      endpointProtocol: "messages",
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=bad-request`,
      virtualModelName: "vm-provider-messages-4xx",
    });
    await fixture.query("update providers set provider_key = 'anthropic' where id = $1", [
      seeded.providerId,
    ]);

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/messages`, {
        body: JSON.stringify({
          max_tokens: 64,
          messages: [{ content: "ping", role: "user" }],
          model: "vm-provider-messages-4xx",
        }),
        headers: {
          authorization: `Bearer ${apiKey}_messages`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(response.headers.get("request-id")).toBe("fake-provider-request");
      expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("88");
      expect(body).toEqual({
        error: {
          code: "context_length_exceeded",
          message: "context length exceeded by fake provider",
        },
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway returns exhausted provider 429 body, status, and headers", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_error_429_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey: `${apiKey}_rate_limit`,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=rate-limit`,
      virtualModelName: "vm-provider-429",
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
          model: "vm-provider-429",
        }),
        headers: {
          authorization: `Bearer ${apiKey}_rate_limit`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body).toEqual({
        error: {
          code: "rate_limit_error",
          message: "Fake provider rate limit",
        },
      });
      expect(response.headers.get("x-request-id")).toBe("fake-provider-request");
      expect(response.headers.get("retry-after")).toBe("2");
      expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("0");
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
      apiKey: `${apiKey}_fallback`,
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
          authorization: `Bearer ${apiKey}_fallback`,
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
        input_modalities,
        output_modalities,
        context_window,
        max_output_tokens,
        supports_streaming,
        supports_function_calling,
        supports_reasoning,
        availability
      )
      values ($1, $2, 'fake-model', 'Fake Model Missing Key', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
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
