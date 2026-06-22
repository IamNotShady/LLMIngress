import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createProviderConnectivityCheckJobHandler } from "../../apps/worker/src/provider-connectivity-check";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import type { MasterKeySource } from "../../packages/security/src/master-key";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";
import { createFakeProviderServer } from "../support/fake-provider";

test("manual provider connectivity check records success and failure results", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connectivity_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({ timeoutMs: 5_000 });
  const masterKeySource = {
    kind: "inline",
    value: "feat-024-connectivity-master-key",
  } satisfies MasterKeySource;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const successProviderId = randomUUID();
    const badCredentialsProviderId = randomUUID();
    const quotaProviderId = randomUUID();
    const timeoutProviderId = randomUUID();
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: successProviderId,
      models: [
        {
          contextWindow: 128_000,
          inputPrice: "0.01",
          modelId: "text-embedding-3-small",
          outputPrice: "0.01",
        },
        {
          contextWindow: 128_000,
          inputPrice: "2.50",
          modelId: "gpt-4o",
          outputPrice: "10.00",
        },
        {
          contextWindow: 1_000_000,
          inputPrice: "0.05",
          modelId: "qwen-turbo",
          outputPrice: "0.20",
        },
      ],
      providerKey: "openai-success",
    });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: badCredentialsProviderId,
      providerKey: "openai-bad-key",
    });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1?mode=openrouter-error`,
      id: quotaProviderId,
      providerKey: "openrouter-quota",
    });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1?mode=timeout`,
      id: timeoutProviderId,
      providerKey: "openai-timeout",
    });
    const badSuccessProviderKeyId = await storeProviderApiKey(
      fixture,
      masterKeySource,
      successProviderId,
      "bad-provider-key-first",
      { priority: 1 },
    );
    const goodSuccessProviderKeyId = await storeProviderApiKey(
      fixture,
      masterKeySource,
      successProviderId,
      "sk-good-provider-key",
      { priority: 2 },
    );
    await storeProviderApiKey(
      fixture,
      masterKeySource,
      badCredentialsProviderId,
      "bad-provider-key",
    );
    await storeProviderApiKey(fixture, masterKeySource, quotaProviderId, "sk-good-provider-key");
    await storeProviderApiKey(fixture, masterKeySource, timeoutProviderId, "sk-good-provider-key");

    const successJob = await runConnectivityJob(fixture, masterKeySource, {
      providerId: successProviderId,
    });
    expect(successJob.status).toBe("succeeded");
    expect(successJob.result).toMatchObject({
      errorCode: null,
      ok: true,
      apiKeyResults: [
        {
          errorCode: "invalid_api_key",
          ok: false,
          providerApiKeyId: badSuccessProviderKeyId,
          status: "auth_failed",
        },
        {
          errorCode: null,
          ok: true,
          providerApiKeyId: goodSuccessProviderKeyId,
          status: "healthy",
        },
      ],
      providerId: successProviderId,
      providerKey: "openai-success",
      status: "healthy",
      statusCode: 200,
    });
    expect(server.requests[0]?.bodyJson).toMatchObject({
      max_tokens: 1,
      model: "qwen-turbo",
    });
    expect(server.requests.slice(0, 2).map((request) => request.headers.authorization)).toEqual([
      "Bearer bad-provider-key-first",
      "Bearer sk-good-provider-key",
    ]);
    await expectProviderApiKeyStatuses(fixture, {
      [badSuccessProviderKeyId]: "auth_failed",
      [goodSuccessProviderKeyId]: "healthy",
    });
    await expectProviderSummaryStatus(fixture, successProviderId, "healthy");

    const badCredentialsJob = await runConnectivityJob(fixture, masterKeySource, {
      providerId: badCredentialsProviderId,
    });
    expect(badCredentialsJob.status).toBe("succeeded");
    expect(badCredentialsJob.result).toMatchObject({
      errorCode: "invalid_api_key",
      errorMessage: "Invalid API key",
      ok: false,
      providerId: badCredentialsProviderId,
      providerKey: "openai-bad-key",
      retryable: false,
      status: "unhealthy",
      statusCode: 401,
    });
    expect(badCredentialsJob.result).toMatchObject({
      apiKeyResults: [{ status: "auth_failed" }],
    });
    await expectProviderSummaryStatus(fixture, badCredentialsProviderId, "unhealthy");

    const quotaJob = await runConnectivityJob(fixture, masterKeySource, {
      providerId: quotaProviderId,
    });
    expect(quotaJob.status).toBe("succeeded");
    expect(quotaJob.result).toMatchObject({
      errorCode: "402",
      errorMessage: "OpenRouter account has insufficient credits",
      ok: false,
      providerId: quotaProviderId,
      providerKey: "openrouter-quota",
      retryable: false,
      status: "unhealthy",
      statusCode: 402,
    });
    expect(quotaJob.result).toMatchObject({
      apiKeyResults: [{ status: "quota_limited" }],
    });
    await expectProviderSummaryStatus(fixture, quotaProviderId, "unhealthy");

    const timeoutJob = await runConnectivityJob(fixture, masterKeySource, {
      providerId: timeoutProviderId,
      timeoutMs: 50,
    });
    expect(timeoutJob.status).toBe("succeeded");
    expect(timeoutJob.result).toMatchObject({
      errorCode: "provider_probe_timeout",
      ok: false,
      providerId: timeoutProviderId,
      providerKey: "openai-timeout",
      retryable: true,
      status: "unhealthy",
      statusCode: null,
    });
    expect(timeoutJob.result).toMatchObject({
      apiKeyResults: [{ status: "network_error" }],
    });
    await expectProviderSummaryStatus(fixture, timeoutProviderId, "unhealthy");
    await expectNoPlaintextKeysPersisted(fixture);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("provider connectivity check refuses non chat-compatible probe models", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connectivity_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({ timeoutMs: 5_000 });
  const masterKeySource = {
    kind: "inline",
    value: "feat-024-connectivity-master-key",
  } satisfies MasterKeySource;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const providerId = randomUUID();
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: providerId,
      models: ["lyria-3-clip-preview", "imagen-4.0-generate-001", "gemini-embedding-001"],
      providerKey: "google",
    });
    await storeProviderApiKey(fixture, masterKeySource, providerId, "sk-good-provider-key");

    const job = await runConnectivityJob(fixture, masterKeySource, { providerId });

    expect(job).toMatchObject({
      errorCode: "job_handler_failed",
      errorMessage: "Provider has no ordinary chat-compatible models for connectivity check.",
      status: "failed",
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("provider connectivity check marks provider unhealthy when no keys are enabled", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connectivity_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({ timeoutMs: 5_000 });
  const masterKeySource = {
    kind: "inline",
    value: "feat-024-connectivity-master-key",
  } satisfies MasterKeySource;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const providerId = randomUUID();
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: providerId,
      providerKey: "openai-no-enabled-key",
    });
    await storeProviderApiKey(fixture, masterKeySource, providerId, "sk-disabled-provider-key", {
      enabled: false,
    });

    const job = await runConnectivityJob(fixture, masterKeySource, { providerId });

    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({
      apiKeyResults: [],
      errorCode: "provider_api_key_unavailable",
      ok: false,
      providerId,
      providerKey: "openai-no-enabled-key",
      status: "unhealthy",
    });
    expect(server.requests).toEqual([]);
    await expectProviderSummaryStatus(fixture, providerId, "unhealthy");
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("provider connectivity check aggregates subscription OAuth connection results", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connectivity_oauth_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({ timeoutMs: 5_000 });
  const masterKeySource = {
    kind: "inline",
    value: "feat-024-connectivity-master-key",
  } satisfies MasterKeySource;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const providerId = randomUUID();
    await insertSubscriptionProvider(fixture, {
      baseUrl: server.url,
      id: providerId,
      models: ["gpt-codex"],
      providerKey: "openai_codex",
    });
    const badOAuthId = await storeProviderOAuthToken(
      fixture,
      masterKeySource,
      providerId,
      "bad-provider-key-oauth",
      { label: "Bad OAuth", priority: 1 },
    );
    const goodOAuthId = await storeProviderOAuthToken(
      fixture,
      masterKeySource,
      providerId,
      "oauth-good-token",
      { label: "Good OAuth", priority: 2 },
    );

    const job = await runConnectivityJob(fixture, masterKeySource, { providerId });

    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({
      oauthResults: [
        {
          errorCode: "invalid_api_key",
          ok: false,
          providerOAuthId: badOAuthId,
          status: "auth_failed",
        },
        {
          errorCode: null,
          ok: true,
          providerOAuthId: goodOAuthId,
          status: "healthy",
        },
      ],
      ok: true,
      providerId,
      providerKey: "openai_codex",
      status: "healthy",
    });
    expect(server.requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer bad-provider-key-oauth",
      "Bearer oauth-good-token",
    ]);
    await expectProviderOAuthStatuses(fixture, {
      [badOAuthId]: "auth_failed",
      [goodOAuthId]: "healthy",
    });
    await expectProviderSummaryStatus(fixture, providerId, "healthy");
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type ProviderInput = {
  baseUrl: string;
  id: string;
  models?: ProviderModelInput[];
  providerKey: string;
};

type ProviderModelInput =
  | string
  | {
      contextWindow?: number | null;
      inputPrice?: number | string | null;
      modelId: string;
      outputPrice?: number | string | null;
    };

type ConnectivityJobInput = {
  providerId: string;
  timeoutMs?: number;
};

type JobRow = {
  errorCode: string | null;
  errorMessage: string | null;
  result: unknown;
  status: string;
};

async function runConnectivityJob(
  fixture: Fixture,
  masterKeySource: MasterKeySource,
  input: ConnectivityJobInput,
): Promise<JobRow> {
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      provider_connectivity_check: createProviderConnectivityCheckJobHandler({
        databaseUrl: fixture.databaseUrl,
        masterKeySource,
      }),
    },
    workerId: `worker-connectivity-${randomUUID()}`,
  });
  const jobId = randomUUID();

  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'provider_connectivity_check', 'pending', 'manual', $2, 1)
    `,
    [jobId, JSON.stringify(input)],
  );

  await runner.runOnce();

  const result = await fixture.query<JobRow>(
    'select status, result, error_code as "errorCode", error_message as "errorMessage" from jobs where id = $1',
    [jobId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Connectivity job was not found.");
  }
  return row;
}

async function insertProvider(fixture: Fixture, input: ProviderInput): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [input.id, input.providerKey, input.providerKey, input.baseUrl],
  );
  for (const modelInput of input.models ?? ["fake-model"]) {
    const model = normalizeProviderModelInput(modelInput);
    await fixture.query(
      `
        insert into provider_models (
          id,
          provider_id,
          model_id,
          display_name,
          context_window,
          availability,
          supports_streaming,
          supports_tools,
          synced_input_usd_per_million_tokens,
          synced_output_usd_per_million_tokens
        )
        values ($1, $2, $3, $3, $4, 'available', true, true, $5, $6)
      `,
      [
        randomUUID(),
        input.id,
        model.modelId,
        model.contextWindow,
        model.inputPrice,
        model.outputPrice,
      ],
    );
  }
}

async function insertSubscriptionProvider(fixture: Fixture, input: ProviderInput): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'subscription', $2, $3, $4, true)
    `,
    [input.id, input.providerKey, input.providerKey, input.baseUrl],
  );
  for (const modelInput of input.models ?? ["fake-model"]) {
    const model = normalizeProviderModelInput(modelInput);
    await fixture.query(
      `
        insert into provider_models (
          id,
          provider_id,
          model_id,
          display_name,
          context_window,
          availability,
          supports_streaming,
          supports_tools,
          synced_input_usd_per_million_tokens,
          synced_output_usd_per_million_tokens
        )
        values ($1, $2, $3, $3, $4, 'available', true, true, $5, $6)
      `,
      [
        randomUUID(),
        input.id,
        model.modelId,
        model.contextWindow,
        model.inputPrice,
        model.outputPrice,
      ],
    );
  }
}

function normalizeProviderModelInput(input: ProviderModelInput): {
  contextWindow: number | null;
  inputPrice: number | string | null;
  modelId: string;
  outputPrice: number | string | null;
} {
  if (typeof input === "string") {
    return {
      contextWindow: 128_000,
      inputPrice: "1.00",
      modelId: input,
      outputPrice: "1.00",
    };
  }

  return {
    contextWindow: input.contextWindow ?? 128_000,
    inputPrice: input.inputPrice ?? null,
    modelId: input.modelId,
    outputPrice: input.outputPrice ?? null,
  };
}

async function storeProviderApiKey(
  fixture: Fixture,
  masterKeySource: MasterKeySource,
  providerId: string,
  plaintext: string,
  options: { enabled?: boolean; priority?: number } = {},
): Promise<string> {
  const encryption = createSecretEncryption(masterKeySource);
  const encryptedKey = encryption.encrypt(plaintext);
  const id = randomUUID();

  await fixture.query(
    `
      insert into provider_api_keys (
        id,
        provider_id,
        key_prefix,
        encrypted_key,
        key_id,
        enabled,
        priority
      )
      values ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      id,
      providerId,
      plaintext.slice(0, 8),
      JSON.stringify(encryptedKey),
      encryption.keyId,
      options.enabled ?? true,
      options.priority ?? 100,
    ],
  );
  return id;
}

async function storeProviderOAuthToken(
  fixture: Fixture,
  masterKeySource: MasterKeySource,
  providerId: string,
  accessToken: string,
  options: { label: string; priority: number },
): Promise<string> {
  const encryption = createSecretEncryption(masterKeySource);
  const id = randomUUID();
  const encryptedToken = encryption.encrypt(
    JSON.stringify({
      accessToken,
      expiresAt: Date.now() + 3_600_000,
      refreshToken: "refresh-token",
      scopes: [],
      tokenType: "Bearer",
    }),
  );

  await fixture.query(
    `
      insert into provider_oauth (
        id,
        provider_id,
        label,
        priority,
        enabled,
        encrypted_token,
        token_expires_at,
        completed_at
      )
      values ($1, $2, $3, $4, true, $5, now() + interval '1 hour', now())
    `,
    [id, providerId, options.label, options.priority, JSON.stringify(encryptedToken)],
  );
  return id;
}

async function expectProviderApiKeyStatuses(
  fixture: Fixture,
  expected: Record<string, string>,
): Promise<void> {
  const result = await fixture.query<{ id: string; last_test_status: string }>(
    `
      select id::text,
             last_test_status
      from provider_api_keys
      where id = any($1::uuid[])
      order by id
    `,
    [Object.keys(expected)],
  );
  expect(Object.fromEntries(result.rows.map((row) => [row.id, row.last_test_status]))).toEqual(
    expected,
  );
}

async function expectProviderOAuthStatuses(
  fixture: Fixture,
  expected: Record<string, string>,
): Promise<void> {
  const result = await fixture.query<{ id: string; last_test_status: string }>(
    `
      select id::text,
             last_test_status
      from provider_oauth
      where id = any($1::uuid[])
      order by id
    `,
    [Object.keys(expected)],
  );
  expect(Object.fromEntries(result.rows.map((row) => [row.id, row.last_test_status]))).toEqual(
    expected,
  );
}

async function expectNoPlaintextKeysPersisted(fixture: Fixture): Promise<void> {
  const result = await fixture.query<{ contains_plaintext: boolean }>(
    `
      select exists (
        select 1
        from jobs
        where payload::text like '%sk-good-provider-key%'
           or payload::text like '%bad-provider-key%'
        union all
        select 1
        from provider_api_keys
        where encrypted_key::text like '%sk-good-provider-key%'
           or encrypted_key::text like '%bad-provider-key%'
      ) as contains_plaintext
    `,
  );
  expect(result.rows).toEqual([{ contains_plaintext: false }]);
}

async function expectProviderSummaryStatus(
  fixture: Fixture,
  providerId: string,
  status: string,
): Promise<void> {
  const result = await fixture.query<{ status: string }>(
    `
      select status
      from provider_health_summary
      where provider_id = $1
        and provider_model_id is null
    `,
    [providerId],
  );
  expect(result.rows).toEqual([{ status }]);
}
