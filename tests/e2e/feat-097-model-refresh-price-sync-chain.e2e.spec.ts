import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { createPostgresJobRunner, JOB_CREATED_CHANNEL } from "../../apps/worker/src/job-runner";
import { createModelRefreshJobHandler } from "../../apps/worker/src/model-refresh";
import { createPriceSyncJobHandler } from "../../apps/worker/src/price-sync";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKeySource = { kind: "inline" as const, value: "test-master-key" };

test("model refresh enqueues asynchronous price sync job for refreshed provider models", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_model_refresh_price_sync_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer({
    models: [{ id: "chain-alpha" }, { id: "chain-beta" }, { id: "chain-alpha" }],
  });
  const providerId = randomUUID();
  const notifications = await captureJobCreatedNotifications(fixture.databaseUrl);

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${provider.url}/v1`,
      id: providerId,
      providerKey: "openai",
    });
    await insertProviderApiKey(fixture, providerId);

    const modelRefreshRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        model_refresh: createModelRefreshJobHandler({
          databaseUrl: fixture.databaseUrl,
          masterKeySource,
        }),
      },
      workerId: `worker-model-refresh-chain-${randomUUID()}`,
    });

    const firstModelRefreshJobId = await insertModelRefreshJob(fixture, providerId);

    await expect(modelRefreshRunner.runOnce()).resolves.toBe(true);

    const firstRefresh = await readJobResult(fixture, firstModelRefreshJobId);
    expect(firstRefresh).toMatchObject({
      status: "succeeded",
      result: {
        fetchedModelCount: 3,
        providerId,
      },
    });
    expect(firstRefresh.result).toMatchObject({
      chainedPriceSyncJobId: expect.any(String),
    });

    const chainedPriceSyncJobId = readResultString(firstRefresh.result, "chainedPriceSyncJobId");
    await expect(readPriceSyncJob(fixture, chainedPriceSyncJobId)).resolves.toMatchObject({
      payload: {
        modelIds: ["chain-alpha", "chain-beta"],
        providerId,
        providerKey: "openai",
        source: "model_refresh",
      },
      status: "pending",
      trigger: "system",
    });
    await expect
      .poll(() => notifications.messages.map((message) => message.jobId))
      .toContain(chainedPriceSyncJobId);

    const secondModelRefreshJobId = await insertModelRefreshJob(fixture, providerId);

    await expect(modelRefreshRunner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, secondModelRefreshJobId)).resolves.toMatchObject({
      result: {
        chainedPriceSyncJobId,
      },
      status: "succeeded",
    });
    await expect(countUnfinishedChainedPriceSyncJobs(fixture, providerId)).resolves.toBe(1);

    const priceSyncRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        price_sync: createPriceSyncJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T00:00:00.000Z"),
        }),
      },
      workerId: `worker-price-sync-chain-${randomUUID()}`,
    });

    await expect(priceSyncRunner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, chainedPriceSyncJobId)).resolves.toMatchObject({
      result: {
        snapshotCount: expect.any(Number),
        trigger: "system",
      },
      status: "succeeded",
    });
  } finally {
    await notifications.close();
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type ProviderInput = {
  baseUrl: string;
  id: string;
  providerKey: string;
};

type JobResult = {
  result: unknown;
  status: string | null;
};

type PriceSyncJobRow = {
  payload: unknown;
  status: string;
  trigger: string;
};

async function insertProvider(fixture: Fixture, input: ProviderInput): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [input.id, input.providerKey, input.providerKey, input.baseUrl],
  );
}

async function insertProviderApiKey(fixture: Fixture, providerId: string): Promise<void> {
  const encrypted = createSecretEncryption(masterKeySource).encrypt("sk-model-refresh-secret");
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, 'sk-model', $3, $4)
    `,
    [randomUUID(), providerId, JSON.stringify(encrypted), encrypted.keyId],
  );
}

async function insertModelRefreshJob(fixture: Fixture, providerId: string): Promise<string> {
  const jobId = randomUUID();
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'model_refresh', 'pending', 'manual', $2, 1)
    `,
    [jobId, JSON.stringify({ providerId })],
  );
  return jobId;
}

async function readJobResult(fixture: Fixture, jobId: string): Promise<JobResult> {
  const result = await fixture.query<{ result: unknown; status: string }>(
    "select status, result from jobs where id = $1",
    [jobId],
  );
  return {
    result: result.rows[0]?.result ?? null,
    status: result.rows[0]?.status ?? null,
  };
}

async function readPriceSyncJob(fixture: Fixture, jobId: string): Promise<PriceSyncJobRow | null> {
  const result = await fixture.query<PriceSyncJobRow>(
    "select status, trigger, payload from jobs where id = $1 and job_type = 'price_sync'",
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function countUnfinishedChainedPriceSyncJobs(
  fixture: Fixture,
  providerId: string,
): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    `
      select count(*)::text as count
      from jobs
      where job_type = 'price_sync'
        and trigger = 'system'
        and status in ('pending', 'running')
        and payload->>'source' = 'model_refresh'
        and payload->>'providerId' = $1
    `,
    [providerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function readResultString(result: unknown, key: string): string {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as Record<string, unknown>)[key] === "string"
  ) {
    return (result as Record<string, string>)[key];
  }
  throw new Error(`Expected job result ${key} to be a string.`);
}

async function captureJobCreatedNotifications(databaseUrl: string): Promise<{
  close: () => Promise<void>;
  messages: Array<{ jobId: string }>;
}> {
  const client = new Client({ connectionString: databaseUrl });
  const messages: Array<{ jobId: string }> = [];

  client.on("notification", (message) => {
    if (message.channel !== JOB_CREATED_CHANNEL || !message.payload) {
      return;
    }

    try {
      const payload = JSON.parse(message.payload) as { jobId?: unknown };
      if (typeof payload.jobId === "string") {
        messages.push({ jobId: payload.jobId });
      }
    } catch {
      return;
    }
  });

  await client.connect();
  await client.query(`listen ${JOB_CREATED_CHANNEL}`);

  return {
    close: async () => {
      await client.query(`unlisten ${JOB_CREATED_CHANNEL}`).catch(() => undefined);
      await client.end();
    },
    messages,
  };
}
