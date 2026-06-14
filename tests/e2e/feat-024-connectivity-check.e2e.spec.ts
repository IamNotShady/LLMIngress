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
    const timeoutProviderId = randomUUID();
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: successProviderId,
      providerKey: "openai-success",
    });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: badCredentialsProviderId,
      providerKey: "openai-bad-key",
    });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1?mode=timeout`,
      id: timeoutProviderId,
      providerKey: "openai-timeout",
    });
    await storeProviderApiKey(fixture, masterKeySource, successProviderId, "sk-good-provider-key");
    await storeProviderApiKey(
      fixture,
      masterKeySource,
      badCredentialsProviderId,
      "bad-provider-key",
    );
    await storeProviderApiKey(fixture, masterKeySource, timeoutProviderId, "sk-good-provider-key");

    const successJob = await runConnectivityJob(fixture, masterKeySource, {
      providerId: successProviderId,
    });
    expect(successJob.status).toBe("succeeded");
    expect(successJob.result).toMatchObject({
      errorCode: null,
      ok: true,
      providerId: successProviderId,
      providerKey: "openai-success",
      status: "healthy",
      statusCode: 200,
    });

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
      status: "failed",
      statusCode: 401,
    });

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
      status: "failed",
      statusCode: null,
    });
    await expectNoPlaintextKeysPersisted(fixture);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type ProviderInput = {
  baseUrl: string;
  id: string;
  providerKey: string;
};

type ConnectivityJobInput = {
  providerId: string;
  timeoutMs?: number;
};

type JobRow = {
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

  const result = await fixture.query<JobRow>("select status, result from jobs where id = $1", [
    jobId,
  ]);
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
}

async function storeProviderApiKey(
  fixture: Fixture,
  masterKeySource: MasterKeySource,
  providerId: string,
  plaintext: string,
): Promise<void> {
  const encryption = createSecretEncryption(masterKeySource);
  const encryptedKey = encryption.encrypt(plaintext);

  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [
      randomUUID(),
      providerId,
      plaintext.slice(0, 8),
      JSON.stringify(encryptedKey),
      encryption.keyId,
    ],
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
