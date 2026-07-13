import { randomUUID } from "node:crypto";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
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

const agentApiKey = "llmi_gateway_recording_resilience_key_094";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChatCompletion(input: { agentApiKey: string; baseUrl: string; model: string }) {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model,
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function postStreamingChatCompletion(input: {
  agentApiKey: string;
  baseUrl: string;
  model: string;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: input.model,
      stream: true,
    }),
    headers: {
      authorization: `Bearer ${input.agentApiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function readFirstStreamChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected streaming response body.");
  }
  const firstChunk = await reader.read();
  await reader.cancel().catch(() => undefined);
  return firstChunk.value ? new TextDecoder().decode(firstChunk.value) : "";
}

async function readStreamBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected streaming response body.");
  }
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    chunks.push(chunk.value);
  }
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

async function installSlowRequestActivityInsertTrigger(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  seconds: number;
}) {
  await input.fixture.query(`
    create or replace function slow_request_activity_insert()
    returns trigger
    language plpgsql
    as $$
    begin
      perform pg_sleep(${input.seconds});
      return new;
    end;
    $$;
  `);
  await input.fixture.query(`
    create trigger slow_request_activity_insert
    before insert on request_activity
    for each row
    execute function slow_request_activity_insert();
  `);
}

async function installSlowGatewayMetadataTriggers(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  seconds: number;
}) {
  await input.fixture.query(`
    create or replace function slow_gateway_metadata_write()
    returns trigger
    language plpgsql
    as $$
    begin
      perform pg_sleep(${input.seconds});
      return new;
    end;
    $$;
  `);
  await input.fixture.query(`
    create trigger slow_fallback_events_insert
    before insert on fallback_events
    for each row
    execute function slow_gateway_metadata_write();
  `);
  await input.fixture.query(`
    create trigger slow_provider_api_keys_update
    before update on provider_api_keys
    for each row
    execute function slow_gateway_metadata_write();
  `);
}

test("gateway still returns the LLM response when recording tables are unavailable", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_recording_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-recording",
    });
    await fixture.query("drop table request_activity cascade");

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-recording",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway returns non-streaming response before slow completed activity insert finishes", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_recording_async_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-recording-async",
    });
    await installSlowRequestActivityInsertTrigger({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-recording-async",
      });
      const elapsedMs = Date.now() - startedAt;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(elapsedMs).toBeLessThan(1_500);

      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway completes streaming response before slow completed activity insert finishes", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_recording_stream_async_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=stream&stream_end_ms=700`,
      virtualModelName: "vm-recording-stream-async",
    });
    await installSlowRequestActivityInsertTrigger({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postStreamingChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-recording-stream-async",
      });
      const body = await readStreamBody(response);
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      expect(body).toContain("fake");
      expect(body).toContain("[DONE]");
      expect(elapsedMs).toBeLessThan(1_500);

      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway returns non-streaming response before slow provider metadata writes finish", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_metadata_async_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "vm-metadata-async",
    });
    await installSlowGatewayMetadataTriggers({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-metadata-async",
      });
      const elapsedMs = Date.now() - startedAt;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });
      expect(elapsedMs).toBeLessThan(1_500);
      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway streams first chunk before slow provider metadata writes finish", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_stream_metadata_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      agentApiKey,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=stream&stream_end_ms=2500`,
      virtualModelName: "vm-stream-metadata",
    });
    await installSlowGatewayMetadataTriggers({ fixture, seconds: 2 });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const startedAt = Date.now();
      const response = await postStreamingChatCompletion({
        agentApiKey,
        baseUrl,
        model: "vm-stream-metadata",
      });
      const firstChunk = await readFirstStreamChunk(response);
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      expect(firstChunk).toContain("fake");
      expect(elapsedMs).toBeLessThan(1_500);
      await delay(2_200);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("gateway persists failed and succeeded fallback events after a successful fallback", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_fallback_events_${randomUUID().replaceAll("-", "_")}`,
  });
  const failingProvider = await createFakeProviderServer();
  const succeedingProvider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedOpenAIGatewayRoute({
      agentApiKey: `${agentApiKey}_fallback`,
      fixture,
      providerBaseUrl: `${failingProvider.url}?mode=error`,
      virtualModelName: "vm-recording-fallback",
    });
    await seedFallbackProviderCandidate({
      fixture,
      providerBaseUrl: succeedingProvider.url,
      routePolicyId: seeded.routePolicyId,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await postChatCompletion({
        agentApiKey: `${agentApiKey}_fallback`,
        baseUrl,
        model: "vm-recording-fallback",
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        choices: [{ message: { content: "fake provider response", role: "assistant" } }],
      });

      await expect
        .poll(async () => {
          const result = await fixture.query<{ status: string; attempt_order: number }>(
            `
              select fallback_events.status,
                     fallback_events.attempt_order
              from fallback_events
              join request_activity on request_activity.id = fallback_events.request_activity_id
              where request_activity.model = 'vm-recording-fallback'
              order by fallback_events.attempt_order
            `,
          );
          return result.rows;
        })
        .toEqual([
          { attempt_order: 1, status: "failed" },
          { attempt_order: 2, status: "succeeded" },
        ]);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await succeedingProvider.close();
    await failingProvider.close();
    await fixture.dispose();
  }
});

async function seedFallbackProviderCandidate(input: {
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>;
  providerBaseUrl: string;
  routePolicyId: string;
}): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: "test-master-key" }).encrypt(
    "fallback-provider-key",
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
      values ($1, 'api_key', 'openai', null, 'OpenAI Fallback', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
  await input.fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [randomUUID(), providerId, "fallback-pro", JSON.stringify(encrypted), encrypted.keyId],
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
      values ($1, $2, 'fake-model', 'Fake Fallback Model', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
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
