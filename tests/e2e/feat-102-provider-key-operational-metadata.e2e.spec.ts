import { randomUUID } from "node:crypto";
import { createProviderConnectivityCheckJobHandler } from "@llmingress/db/worker-provider-connectivity-check";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { executeGatewayOpenAIChatCompletion } from "../../packages/db/src/gateway-chat-completions";
import { loadGatewayConfigSnapshot } from "../../packages/db/src/gateway-config-reload";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

const masterKey = "test-master-key";
const disabledProviderApiKey = "bad-provider-key-disabled-102";
const goodProviderApiKey = "sk-good-provider-key-102";
const laterProviderApiKey = "bad-provider-key-later-102";

test("provider key management records label status priority usage and per key connectivity", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_key_ops_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedProviderKeyOperationalGateway(fixture);
    const snapshot = await loadGatewayConfigSnapshot(fixture.databaseUrl);
    const calls: string[] = [];

    const response = await executeGatewayOpenAIChatCompletion({
      adapter: {
        chatCompletion: async ({ target }) => {
          calls.push(target.apiKey);
          return {
            body: {
              choices: [{ message: { content: "ok", role: "assistant" } }],
              id: "ok-102",
              object: "chat.completion",
            },
            ok: true,
            providerRequestId: "ok-102",
            statusCode: 200,
          };
        },
      },
      agentApiKeyId: seeded.agentApiKeyId,
      databaseUrl: fixture.databaseUrl,
      masterKeySource: { kind: "inline", value: masterKey },
      requestBody: {
        max_tokens: 16,
        messages: [{ content: "use prioritized provider key", role: "user" }],
        model: "provider-key-ops",
        stream: false,
      },
      requestId: "req_provider_key_ops_102",
      snapshot,
      virtualModel: { id: seeded.virtualModelId, name: "provider-key-ops" },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([goodProviderApiKey]);
    await expectProviderKeyUsage(fixture, {
      disabledProviderApiKeyId: seeded.disabledProviderApiKeyId,
      goodProviderApiKeyId: seeded.goodProviderApiKeyId,
      laterProviderApiKeyId: seeded.laterProviderApiKeyId,
    });

    const probeAuthorizations: string[] = [];
    const jobId = await insertConnectivityJob(fixture, {
      providerApiKeyId: seeded.laterProviderApiKeyId,
      providerId: seeded.providerId,
    });
    const handler = createProviderConnectivityCheckJobHandler({
      databaseUrl: fixture.databaseUrl,
      fetch: async (_url, init) => {
        probeAuthorizations.push(readAuthorization(init?.headers));
        return new Response(
          JSON.stringify({
            error: { code: "invalid_api_key", message: "Invalid API key" },
          }),
          { headers: { "content-type": "application/json" }, status: 401 },
        );
      },
      masterKeySource: { kind: "inline", value: masterKey },
    });

    await expect(
      handler({
        attemptNumber: 1,
        id: jobId,
        jobType: "provider_connectivity_check",
        maxAttempts: 3,
        payload: {
          providerApiKeyId: seeded.laterProviderApiKeyId,
          providerId: seeded.providerId,
        },
        priority: 0,
        trigger: "manual",
        workerId: "worker-102",
      }),
    ).resolves.toMatchObject({
      apiKeyResults: [
        {
          errorCode: "invalid_api_key",
          ok: false,
          providerApiKeyId: seeded.goodProviderApiKeyId,
          status: "auth_failed",
        },
        {
          errorCode: "invalid_api_key",
          ok: false,
          providerApiKeyId: seeded.laterProviderApiKeyId,
          status: "auth_failed",
        },
      ],
      errorCode: "invalid_api_key",
      ok: false,
      requestedProviderApiKeyId: seeded.laterProviderApiKeyId,
      status: "unhealthy",
    });
    expect(probeAuthorizations).toEqual([
      `Bearer ${goodProviderApiKey}`,
      `Bearer ${laterProviderApiKey}`,
    ]);
    await expectProviderKeyTestResult(fixture, {
      goodProviderApiKeyId: seeded.goodProviderApiKeyId,
      laterProviderApiKeyId: seeded.laterProviderApiKeyId,
    });
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type SeededProviderKeyOperationalGateway = {
  agentApiKeyId: string;
  disabledProviderApiKeyId: string;
  goodProviderApiKeyId: string;
  laterProviderApiKeyId: string;
  providerId: string;
  virtualModelId: string;
};

type ProviderKeyUsageRow = {
  id: string;
  last_used_at: Date | null;
};

type ProviderKeyTestRow = {
  id: string;
  last_test_error_code: string | null;
  last_test_error_message: string | null;
  last_test_status: string;
  last_tested_at: Date | null;
};

async function seedProviderKeyOperationalGateway(
  fixture: Fixture,
): Promise<SeededProviderKeyOperationalGateway> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const disabledProviderApiKeyId = randomUUID();
  const goodProviderApiKeyId = randomUUID();
  const laterProviderApiKeyId = randomUUID();
  const encryption = createSecretEncryption({ kind: "inline", value: masterKey });

  await fixture.query(
    `
      insert into providers (
        id,
        provider_type,
        provider_key,
        display_name,
        base_url,
        enabled,
        default_priority
      )
      values ($1, 'api_key', 'provider-key-ops', 'Provider Key Ops', 'https://provider.example/v1', true, 10)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (
        id,
        provider_id,
        key_prefix,
        encrypted_key,
        key_id,
        label,
        enabled,
        priority,
        created_at
      )
      values ($1, $2, $3, $4, $5, 'Disabled key', false, 0, '2026-01-01T00:00:00Z'),
             ($6, $2, $7, $8, $9, 'Primary subscription', true, 5, '2026-01-01T00:00:01Z'),
             ($10, $2, $11, $12, $13, 'Fallback subscription', true, 10, '2026-01-01T00:00:02Z')
    `,
    [
      disabledProviderApiKeyId,
      providerId,
      disabledProviderApiKey.slice(0, 8),
      JSON.stringify(encryption.encrypt(disabledProviderApiKey)),
      encryption.keyId,
      goodProviderApiKeyId,
      goodProviderApiKey.slice(0, 8),
      JSON.stringify(encryption.encrypt(goodProviderApiKey)),
      encryption.keyId,
      laterProviderApiKeyId,
      laterProviderApiKey.slice(0, 8),
      JSON.stringify(encryption.encrypt(laterProviderApiKey)),
      encryption.keyId,
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
        supports_tools,
        availability
      )
      values ($1, $2, 'provider-key-model', 'Provider Key Model', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'provider-key-ops', 'Provider Key Ops', true)",
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
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Provider Key Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi-pko-102', key_hash = 'hash-not-used-102', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [agentApiKeyId, agentId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Provider key ops config')",
  );

  return {
    agentApiKeyId,
    disabledProviderApiKeyId,
    goodProviderApiKeyId,
    laterProviderApiKeyId,
    providerId,
    virtualModelId,
  };
}

async function insertConnectivityJob(
  fixture: Fixture,
  input: { providerApiKeyId: string; providerId: string },
): Promise<string> {
  const jobId = randomUUID();
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload)
      values (
        $1,
        'provider_connectivity_check',
        'running',
        'manual',
        jsonb_build_object('providerId', $2::text, 'providerApiKeyId', $3::text)
      )
    `,
    [jobId, input.providerId, input.providerApiKeyId],
  );
  return jobId;
}

async function expectProviderKeyUsage(
  fixture: Fixture,
  input: {
    disabledProviderApiKeyId: string;
    goodProviderApiKeyId: string;
    laterProviderApiKeyId: string;
  },
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await fixture.query<ProviderKeyUsageRow>(
        `
          select id::text,
                 last_used_at
          from provider_api_keys
          where id = any($1::uuid[])
          order by id
        `,
        [[input.disabledProviderApiKeyId, input.goodProviderApiKeyId, input.laterProviderApiKeyId]],
      );
      return Object.fromEntries(
        result.rows.map((row) => [row.id, row.last_used_at === null ? null : "used"]),
      );
    })
    .toEqual({
      [input.disabledProviderApiKeyId]: null,
      [input.goodProviderApiKeyId]: "used",
      [input.laterProviderApiKeyId]: null,
    });
}

async function expectProviderKeyTestResult(
  fixture: Fixture,
  input: { goodProviderApiKeyId: string; laterProviderApiKeyId: string },
): Promise<void> {
  const result = await fixture.query<ProviderKeyTestRow>(
    `
      select id::text,
             last_test_status,
             last_test_error_code,
             last_test_error_message,
             last_tested_at
      from provider_api_keys
      where id = any($1::uuid[])
      order by id
    `,
    [[input.goodProviderApiKeyId, input.laterProviderApiKeyId]],
  );
  const rows = new Map(result.rows.map((row) => [row.id, row]));

  expect(rows.get(input.goodProviderApiKeyId)).toMatchObject({
    last_test_error_code: "invalid_api_key",
    last_test_error_message: "Invalid API key",
    last_test_status: "auth_failed",
  });
  expect(rows.get(input.goodProviderApiKeyId)?.last_tested_at).toBeInstanceOf(Date);
  expect(rows.get(input.laterProviderApiKeyId)).toMatchObject({
    last_test_error_code: "invalid_api_key",
    last_test_error_message: "Invalid API key",
    last_test_status: "auth_failed",
  });
  expect(rows.get(input.laterProviderApiKeyId)?.last_tested_at).toBeInstanceOf(Date);
}

function readAuthorization(headers: HeadersInit | undefined): string {
  if (!headers) {
    return "";
  }
  if (headers instanceof Headers) {
    return headers.get("authorization") ?? "";
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  }
  const value = headers.authorization ?? headers.Authorization;
  return Array.isArray(value) ? value.join(" ") : (value ?? "");
}
