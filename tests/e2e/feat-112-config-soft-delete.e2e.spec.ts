import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getConsoleActivityDetail } from "../../apps/console/src/server/activity";
import { deleteAgent, listAgents } from "../../apps/console/src/server/agents";
import { deleteRoutePolicy } from "../../apps/console/src/server/route-policies";
import {
  deleteVirtualModel,
  listVirtualModels,
} from "../../apps/console/src/server/virtual-models";
import {
  completeGatewayRequestActivity,
  createGatewayRequestActivity,
} from "../../apps/gateway/src/activity-recorder";
import { loadGatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("config deletes are soft and runtime history remains intact", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_config_soft_delete_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seed = await seedConfig(fixture);
    const requestId = `soft-delete-${randomUUID()}`;

    const activity = await createGatewayRequestActivity({
      agentApiKeyId: seed.agentId,
      agentApiKeyPrefix: "soft112",
      databaseUrl: fixture.databaseUrl,
      model: "soft-delete-vm",
      protocol: "chat_completions",
      requestId,
      stream: false,
      virtualModelId: seed.virtualModelId,
    });
    await completeGatewayRequestActivity({
      activityId: activity.id,
      databaseUrl: fixture.databaseUrl,
      requestLoggingEnabled: true,
      responseBody: { usage: { completion_tokens: 2, prompt_tokens: 3 } },
      route: {
        modelId: "gpt-soft-112",
        providerId: seed.providerId,
        providerKey: "openai-soft-112",
        providerModelId: seed.providerModelId,
        routePolicyId: seed.routePolicyId,
        routeReason: { selected: "seed" },
      },
      startedAt: activity.startedAt,
      statusCode: 200,
    });

    await renameConfig(fixture, seed);
    await expectActivitySnapshots(fixture.databaseUrl, requestId);

    await deleteAgent({ databaseUrl: fixture.databaseUrl, id: seed.agentId });
    await expect(readAgentState(fixture, seed.agentId)).resolves.toMatchObject({
      deleted: true,
      enabled: false,
      rowCount: 1,
    });
    await expect(listAgents(fixture.databaseUrl)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: seed.agentId })]),
    );

    await expect(
      deleteVirtualModel({ databaseUrl: fixture.databaseUrl, id: seed.virtualModelId }),
    ).rejects.toThrow(/route policy/i);

    await expect(readSnapshotVirtualModelNames(fixture.databaseUrl)).resolves.toEqual([
      "renamed-vm",
    ]);

    await fixture.query("update provider_models set deleted_at = now() where id = $1", [
      seed.providerModelId,
    ]);
    await expect(readSnapshotVirtualModelNames(fixture.databaseUrl)).resolves.toEqual([]);
    await fixture.query("update provider_models set deleted_at = null where id = $1", [
      seed.providerModelId,
    ]);

    await fixture.query("update providers set deleted_at = now() where id = $1", [seed.providerId]);
    await expect(readSnapshotVirtualModelNames(fixture.databaseUrl)).resolves.toEqual([]);
    await fixture.query("update providers set deleted_at = null where id = $1", [seed.providerId]);

    await deleteRoutePolicy({ databaseUrl: fixture.databaseUrl, id: seed.routePolicyId });
    await expect(readRoutePolicyState(fixture, seed.routePolicyId)).resolves.toMatchObject({
      candidateCount: 1,
      deleted: true,
      rowCount: 1,
    });
    await expect(readSnapshotVirtualModelNames(fixture.databaseUrl)).resolves.toEqual([]);

    await deleteVirtualModel({ databaseUrl: fixture.databaseUrl, id: seed.virtualModelId });
    await expect(readVirtualModelState(fixture, seed.virtualModelId)).resolves.toMatchObject({
      deleted: true,
      enabled: false,
      rowCount: 1,
    });
    await expect(listVirtualModels(fixture.databaseUrl)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: seed.virtualModelId })]),
    );
  } finally {
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type SeedConfig = {
  agentId: string;
  providerId: string;
  providerModelId: string;
  routePolicyId: string;
  virtualModelId: string;
};

async function seedConfig(fixture: Fixture): Promise<SeedConfig> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai-soft-112', 'OpenAI Snapshot', 'https://api.openai.com/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        supports_streaming,
        supports_tools,
        availability
      )
      values ($1, $2, 'gpt-soft-112', 'GPT Soft Snapshot', true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, 'soft-delete-vm', 'Soft Delete VM Snapshot', true)
    `,
    [virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'random')
    `,
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
  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, 'Agent Snapshot', 'coding', 'soft112', 'hash-soft-112', $2, true)
    `,
    [agentId, virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentId, virtualModelId],
  );

  return { agentId, providerId, providerModelId, routePolicyId, virtualModelId };
}

async function renameConfig(fixture: Fixture, seed: SeedConfig): Promise<void> {
  await fixture.query("update agents set name = 'Renamed Agent' where id = $1", [seed.agentId]);
  await fixture.query("update virtual_models set name = 'renamed-vm' where id = $1", [
    seed.virtualModelId,
  ]);
  await fixture.query(
    "update providers set provider_key = 'renamed-provider', display_name = 'Renamed Provider' where id = $1",
    [seed.providerId],
  );
  await fixture.query(
    "update provider_models set model_id = 'renamed-model', display_name = 'Renamed Model' where id = $1",
    [seed.providerModelId],
  );
}

async function expectActivitySnapshots(databaseUrl: string, requestId: string): Promise<void> {
  const detail = await getConsoleActivityDetail({ databaseUrl, requestId });

  expect(detail?.activity).toMatchObject({
    agentName: "Agent Snapshot",
    providerDisplayName: "OpenAI Snapshot",
    providerKey: "openai-soft-112",
    providerModelDisplayName: "GPT Soft Snapshot",
    providerModelName: "gpt-soft-112",
    virtualModelName: "soft-delete-vm",
  });
}

async function readSnapshotVirtualModelNames(databaseUrl: string): Promise<string[]> {
  const snapshot = await loadGatewayConfigSnapshot(databaseUrl);
  return snapshot.routePolicies.map((routePolicy) => routePolicy.virtualModelName);
}

async function readAgentState(fixture: Fixture, agentId: string) {
  const result = await fixture.query<{ deleted: boolean; enabled: boolean; row_count: number }>(
    `
      select count(*)::integer as row_count,
             bool_or(deleted_at is not null) as deleted,
             bool_and(enabled) as enabled
      from agents
      where id = $1
    `,
    [agentId],
  );
  const row = result.rows[0];
  return {
    deleted: row?.deleted ?? false,
    enabled: row?.enabled ?? true,
    rowCount: row?.row_count ?? 0,
  };
}

async function readRoutePolicyState(fixture: Fixture, routePolicyId: string) {
  const result = await fixture.query<{
    candidate_count: number;
    deleted: boolean;
    row_count: number;
  }>(
    `
      select count(distinct route_policies.id)::integer as row_count,
             count(route_policy_candidates.id)::integer as candidate_count,
             bool_or(route_policies.deleted_at is not null) as deleted
      from route_policies
      left join route_policy_candidates on route_policy_candidates.route_policy_id = route_policies.id
      where route_policies.id = $1
    `,
    [routePolicyId],
  );
  const row = result.rows[0];
  return {
    candidateCount: row?.candidate_count ?? 0,
    deleted: row?.deleted ?? false,
    rowCount: row?.row_count ?? 0,
  };
}

async function readVirtualModelState(fixture: Fixture, virtualModelId: string) {
  const result = await fixture.query<{ deleted: boolean; enabled: boolean; row_count: number }>(
    `
      select count(*)::integer as row_count,
             bool_or(deleted_at is not null) as deleted,
             bool_and(enabled) as enabled
      from virtual_models
      where id = $1
    `,
    [virtualModelId],
  );
  const row = result.rows[0];
  return {
    deleted: row?.deleted ?? false,
    enabled: row?.enabled ?? true,
    rowCount: row?.row_count ?? 0,
  };
}
