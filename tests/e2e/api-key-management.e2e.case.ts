import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  listApiKeyLimitRuntimeSnapshots,
  listApiKeyLimits,
  listSavedApiKeyLimits,
} from "../../packages/db/src/console-api-key-limits";
import {
  type ApiKeyLimitRuleInput,
  createApiKeyWithSettings,
  normalizeApiKeyFormInput,
  normalizeApiKeyVirtualModelSelectionInput,
  setApiKeyEnabled,
  updateApiKeyWithSettings,
} from "../../packages/db/src/console-api-keys";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import { enforceGatewayApiKeyLimitsIfEnabled } from "../../packages/gateway-runtime/src/gateway-api-key-limits";
import { authenticateGatewayRequest } from "../../packages/gateway-runtime/src/gateway-auth";

const rpmRule: ApiKeyLimitRuleInput = {
  enforcementPolicy: "block",
  limitType: "rpm",
  limitValue: 60,
  manualBypass: false,
  period: "minute",
  unit: "requests",
};

test("ApiKey creation is atomic and explicit switches preserve credentials, grants, and limits", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_api_key_contract_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const virtualModelId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
      client.query(
        `insert into virtual_models (id, name, description, enabled)
         values ($1, 'api-key-contract-vm', 'ApiKey contract VM', true)`,
        [virtualModelId],
      ),
    );

    const apiKey = normalizeApiKeyFormInput({
      name: "contract-apiKey",
    });
    const virtualModels = normalizeApiKeyVirtualModelSelectionInput({
      allowedVirtualModelIds: [virtualModelId],
      defaultVirtualModelId: virtualModelId,
    });
    const created = await createApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      limitRules: [rpmRule],
      limitsEnabled: true,
      virtualModels,
    });

    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: true,
    });

    await expect(
      createApiKeyWithSettings({
        apiKey: normalizeApiKeyFormInput({ name: "rolled-back" }),
        databaseUrl: fixture.databaseUrl,
        limitRules: [{ ...rpmRule, limitType: "invalid" } as unknown as ApiKeyLimitRuleInput],
        limitsEnabled: true,
        virtualModels: normalizeApiKeyVirtualModelSelectionInput({
          allowedVirtualModelIds: [virtualModelId],
          defaultVirtualModelId: null,
        }),
      }),
    ).rejects.toThrow();

    const rolledBack = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
      client.query("select 1 from api_keys where name = 'rolled-back'"),
    );
    expect(rolledBack.rows).toEqual([]);

    await updateApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: [],
      limitsEnabled: false,
      virtualModels,
    });
    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: false,
    });
    await expect(listSavedApiKeyLimits(fixture.databaseUrl)).resolves.toMatchObject([
      { apiKeyId: created.id, limitType: "rpm", limitValue: 60 },
    ]);

    await setApiKeyEnabled({ databaseUrl: fixture.databaseUrl, enabled: false, id: created.id });
    await expect(
      authenticateGatewayRequest({
        databaseUrl: fixture.databaseUrl,
        headers: { authorization: `Bearer ${created.plaintext}` },
      }),
    ).resolves.toMatchObject({
      body: { error: { code: "disabled_api_key" } },
      ok: false,
    });

    await setApiKeyEnabled({ databaseUrl: fixture.databaseUrl, enabled: true, id: created.id });
    await expect(
      authenticateGatewayRequest({
        databaseUrl: fixture.databaseUrl,
        headers: { authorization: `Bearer ${created.plaintext}` },
      }),
    ).resolves.toMatchObject({
      apiKey: { limitsEnabled: false },
      ok: true,
    });
    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: false,
    });

    await updateApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: [rpmRule],
      limitsEnabled: true,
      virtualModels,
    });
    await expect(
      enforceGatewayApiKeyLimitsIfEnabled({
        apiKeyId: created.id,
        databaseUrl: fixture.databaseUrl,
        limitsEnabled: true,
        requestId: "gw_api_key_limits_restored",
        requestMetadata: { estimatedInputTokens: 1, estimatedOutputTokens: 1 },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 1,
      limitsEnabled: true,
    });
  } finally {
    await fixture.dispose();
  }
});

test("Limits list and runtime metrics include only enabled ApiKeys with Limits enabled", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_limits_list_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const visibleApiKeyId = randomUUID();
    const disabledApiKeyId = randomUUID();
    const limitsDisabledApiKeyId = randomUUID();
    const noRulesApiKeyId = randomUUID();

    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      await client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
         values ($1, 'visible-limits', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, true),
                ($2, 'disabled-apiKey', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, false, true),
                ($3, 'limits-disabled', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, false),
                ($4, 'no-rules', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, true)`,
        [visibleApiKeyId, disabledApiKeyId, limitsDisabledApiKeyId, noRulesApiKeyId],
      );
      await client.query(
        `insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit)
         values ($1, $2, 'rpm', 'minute', 60, 'requests'),
                ($3, $4, 'rpm', 'minute', 60, 'requests'),
                ($5, $6, 'rpm', 'minute', 60, 'requests')`,
        [
          randomUUID(),
          visibleApiKeyId,
          randomUUID(),
          disabledApiKeyId,
          randomUUID(),
          limitsDisabledApiKeyId,
        ],
      );
      await client.query(
        `insert into rate_limit_windows (
           id, api_key_id, limit_type, window_start, window_end, request_count
         ) values
           ($1, $2, 'rpm', now() - interval '1 minute', now() + interval '1 minute', 5),
           ($3, $4, 'rpm', now() - interval '1 minute', now() + interval '1 minute', 9),
           ($5, $6, 'rpm', now() - interval '1 minute', now() + interval '1 minute', 11)`,
        [
          randomUUID(),
          visibleApiKeyId,
          randomUUID(),
          disabledApiKeyId,
          randomUUID(),
          limitsDisabledApiKeyId,
        ],
      );
    });

    await expect(listApiKeyLimits(fixture.databaseUrl)).resolves.toMatchObject([
      { apiKeyId: visibleApiKeyId, limitType: "rpm", limitValue: 60 },
    ]);
    await expect(listApiKeyLimitRuntimeSnapshots(fixture.databaseUrl)).resolves.toMatchObject([
      { apiKeyId: visibleApiKeyId, currentRpm: 5 },
    ]);
  } finally {
    await fixture.dispose();
  }
});

async function expectApiKeyState(
  databaseUrl: string,
  apiKeyId: string,
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
      `select api_keys.enabled,
              api_keys.limits_enabled,
              (select count(*)::integer from api_key_virtual_models where api_key_id = api_keys.id)
                as grant_count,
              (select count(*)::integer from api_key_limits where api_key_id = api_keys.id)
                as limit_count
       from api_keys
       where api_keys.id = $1`,
      [apiKeyId],
    ),
  );
  expect(result.rows[0]).toEqual({
    enabled: expected.enabled,
    grant_count: expected.grantCount,
    limit_count: expected.limitCount,
    limits_enabled: expected.limitsEnabled,
  });
}
