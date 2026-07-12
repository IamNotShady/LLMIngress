import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  type AgentLimitRuleInput,
  createAgentWithSettings,
  normalizeAgentFormInput,
  normalizeAgentVirtualModelSelectionInput,
  setAgentEnabled,
  updateAgentWithSettings,
} from "../../packages/db/src/console-agents";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import { enforceGatewayAgentLimitsIfEnabled } from "../../packages/gateway-runtime/src/gateway-agent-limits";
import { authenticateGatewayRequest } from "../../packages/gateway-runtime/src/gateway-auth";

const rpmRule: AgentLimitRuleInput = {
  enforcementPolicy: "block",
  limitType: "rpm",
  limitValue: 60,
  manualBypass: false,
  period: "minute",
  unit: "requests",
};

test("Agent creation is atomic and explicit switches preserve credentials, grants, and limits", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_agent_contract_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const virtualModelId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
      client.query(
        `insert into virtual_models (id, name, description, enabled)
         values ($1, 'agent-contract-vm', 'Agent contract VM', true)`,
        [virtualModelId],
      ),
    );

    const agent = normalizeAgentFormInput({
      integrationPlatform: "codex",
      name: "contract-agent",
    });
    const virtualModels = normalizeAgentVirtualModelSelectionInput({
      allowedVirtualModelIds: [virtualModelId],
      defaultVirtualModelId: virtualModelId,
    });
    const created = await createAgentWithSettings({
      agent,
      databaseUrl: fixture.databaseUrl,
      limitRules: [rpmRule],
      limitsEnabled: true,
      virtualModels,
    });

    await expectAgentState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: true,
    });

    await expect(
      createAgentWithSettings({
        agent: normalizeAgentFormInput({ integrationPlatform: "other", name: "rolled-back" }),
        databaseUrl: fixture.databaseUrl,
        limitRules: [{ ...rpmRule, limitType: "invalid" } as unknown as AgentLimitRuleInput],
        limitsEnabled: true,
        virtualModels: normalizeAgentVirtualModelSelectionInput({
          allowedVirtualModelIds: [virtualModelId],
          defaultVirtualModelId: null,
        }),
      }),
    ).rejects.toThrow();

    const rolledBack = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
      client.query("select 1 from agents where name = 'rolled-back'"),
    );
    expect(rolledBack.rows).toEqual([]);

    await updateAgentWithSettings({
      agent,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: [],
      limitsEnabled: false,
      virtualModels,
    });
    await expectAgentState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: false,
    });

    await setAgentEnabled({ databaseUrl: fixture.databaseUrl, enabled: false, id: created.id });
    await expect(
      authenticateGatewayRequest({
        databaseUrl: fixture.databaseUrl,
        headers: { authorization: `Bearer ${created.plaintext}` },
      }),
    ).resolves.toMatchObject({
      body: { error: { code: "disabled_agent_api_key" } },
      ok: false,
    });

    await setAgentEnabled({ databaseUrl: fixture.databaseUrl, enabled: true, id: created.id });
    await expect(
      authenticateGatewayRequest({
        databaseUrl: fixture.databaseUrl,
        headers: { authorization: `Bearer ${created.plaintext}` },
      }),
    ).resolves.toMatchObject({
      agentApiKey: { limitsEnabled: false },
      ok: true,
    });
    await expectAgentState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: false,
    });

    await updateAgentWithSettings({
      agent,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: [rpmRule],
      limitsEnabled: true,
      virtualModels,
    });
    await expect(
      enforceGatewayAgentLimitsIfEnabled({
        agentId: created.id,
        databaseUrl: fixture.databaseUrl,
        limitsEnabled: true,
        requestId: "gw_agent_limits_restored",
        requestMetadata: { estimatedInputTokens: 1, estimatedOutputTokens: 1 },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expectAgentState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: true,
    });
  } finally {
    await fixture.dispose();
  }
});

async function expectAgentState(
  databaseUrl: string,
  agentId: string,
  expected: {
    enabled: boolean;
    grantCount: number;
    limitCount: number;
    limitsEnabled: boolean;
  },
) {
  const result = await withDedicatedPostgresClient(databaseUrl, (client) =>
    client.query<{
      enabled: boolean;
      grant_count: number;
      limit_count: number;
      limits_enabled: boolean;
    }>(
      `select agents.enabled,
              agents.limits_enabled,
              (select count(*)::integer from agent_virtual_models where agent_id = agents.id)
                as grant_count,
              (select count(*)::integer from agent_limits where agent_id = agents.id)
                as limit_count
       from agents
       where agents.id = $1`,
      [agentId],
    ),
  );
  expect(result.rows[0]).toEqual({
    enabled: expected.enabled,
    grant_count: expected.grantCount,
    limit_count: expected.limitCount,
    limits_enabled: expected.limitsEnabled,
  });
}
