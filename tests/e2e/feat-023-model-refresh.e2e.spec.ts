import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createModelRefreshJobHandler } from "../../apps/worker/src/model-refresh";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKeySource = { kind: "inline" as const, value: "test-master-key" };

test("model refresh writes derived rows marks missing referenced models unavailable and publishes config version only on routing-visible change", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_model_refresh_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({
    models: [{ id: "stable" }, { id: "stable" }, { id: "old-referenced" }],
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: providerId,
      providerKey: "openai",
    });
    await insertProviderApiKey(fixture, providerId);

    await runModelRefreshJob(fixture, providerId);

    await expectModelRows(fixture, [
      { availability: "available", model_id: "old-referenced" },
      { availability: "available", model_id: "stable" },
    ]);
    await expectConfigVersionCount(fixture, 0);

    const referencedModelId = await readProviderModelId(fixture, providerId, "old-referenced");
    await insertRouteReference(fixture, referencedModelId);

    server.setModels([{ id: "stable" }, { id: "new-derived" }]);
    await runModelRefreshJob(fixture, providerId);

    await expectModelRows(fixture, [
      { availability: "available", model_id: "new-derived" },
      { availability: "unavailable", model_id: "old-referenced" },
      { availability: "available", model_id: "stable" },
    ]);
    await expectConfigVersionCount(fixture, 1);
    await expectProviderModelConfigChanges(fixture, [referencedModelId]);

    await runModelRefreshJob(fixture, providerId);

    await expectConfigVersionCount(fixture, 1);
  } finally {
    await server.close();
    await fixture.dispose();
  }
});

test("anthropic model refresh authenticates model list with Anthropic API key headers", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_anthropic_model_refresh_${randomUUID().replaceAll("-", "_")}`,
  });
  const server = await createFakeProviderServer({
    models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await insertProvider(fixture, {
      baseUrl: `${server.url}/v1`,
      id: providerId,
      providerKey: "anthropic",
    });
    await insertProviderApiKey(fixture, providerId);

    await runModelRefreshJob(fixture, providerId);

    expect(server.requests[0]?.path).toBe("/v1/models");
    expect(server.requests[0]?.headers["x-api-key"]).toBe("sk-model-refresh-secret");
    expect(server.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    await expectModelRows(fixture, [{ availability: "available", model_id: "claude-sonnet-4-5" }]);
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

type ModelRow = {
  availability: string;
  model_id: string;
};

async function runModelRefreshJob(fixture: Fixture, providerId: string): Promise<void> {
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      model_refresh: createModelRefreshJobHandler({
        databaseUrl: fixture.databaseUrl,
        masterKeySource,
      }),
    },
    workerId: `worker-model-refresh-${randomUUID()}`,
  });
  const jobId = randomUUID();

  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'model_refresh', 'pending', 'manual', $2, 1)
    `,
    [jobId, JSON.stringify({ providerId })],
  );

  await runner.runOnce();

  const result = await fixture.query<{ error_message: string | null; status: string }>(
    "select status, error_message from jobs where id = $1",
    [jobId],
  );
  expect(result.rows[0]).toEqual({
    error_message: null,
    status: "succeeded",
  });
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

async function insertRouteReference(fixture: Fixture, providerModelId: string): Promise<void> {
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  await fixture.query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, $2, $3, true)",
    [virtualModelId, `vm_${randomUUID().replaceAll("-", "_")}`, "Refresh Route"],
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
        candidate_order,
        is_fallback
      )
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
}

async function readProviderModelId(
  fixture: Fixture,
  providerId: string,
  modelId: string,
): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text as id from provider_models where provider_id = $1 and model_id = $2",
    [providerId, modelId],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`Provider model ${modelId} was not found.`);
  }
  return id;
}

async function expectModelRows(fixture: Fixture, expectedRows: ModelRow[]): Promise<void> {
  const result = await fixture.query<ModelRow>(
    `
      select model_id, availability
      from provider_models
      order by model_id
    `,
  );
  expect(result.rows).toEqual(expectedRows);
}

async function expectConfigVersionCount(fixture: Fixture, expectedCount: number): Promise<void> {
  const result = await fixture.query<{ count: string }>(
    "select count(*)::text as count from config_versions",
  );
  expect(result.rows).toEqual([{ count: String(expectedCount) }]);
}

async function expectProviderModelConfigChanges(
  fixture: Fixture,
  expectedRecordIds: string[],
): Promise<void> {
  const result = await fixture.query<{ changed_record_id: string }>(
    `
      select changed_record_id::text
      from config_change_events
      where changed_table = 'provider_models'
      order by changed_record_id
    `,
  );
  expect(result.rows.map((row) => row.changed_record_id)).toEqual([...expectedRecordIds].sort());
}
