import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  listApiKeyLimitRuntimeSnapshots,
  listApiKeyLimits,
  listConsoleCurrentBudgetPeriods,
  listSavedApiKeyLimits,
  normalizeApiKeyLimitFormInput,
  saveApiKeyLimitRules,
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

const completeRules: ApiKeyLimitRuleInput[] = [
  {
    enforcementPolicy: "block",
    limitType: "budget",
    limitValue: 25,
    manualBypass: false,
    period: "month",
    unit: "usd",
  },
  rpmRule,
  {
    enforcementPolicy: "block",
    limitType: "tpm",
    limitValue: 50_000,
    manualBypass: false,
    period: "minute",
    unit: "tokens",
  },
  {
    enforcementPolicy: "block",
    limitType: "token",
    limitValue: 16_384,
    manualBypass: false,
    period: "request",
    unit: "tokens",
  },
  {
    enforcementPolicy: "block",
    limitType: "concurrency",
    limitValue: 4,
    manualBypass: false,
    period: "request",
    unit: "requests",
  },
];

test("ApiKey creation is atomic and disabling limits removes their rules", async () => {
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
      limitRules: completeRules,
      limitsEnabled: true,
      virtualModels,
    });

    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 5,
      limitsEnabled: true,
    });

    await expect(
      createApiKeyWithSettings({
        apiKey: normalizeApiKeyFormInput({ name: "rolled-back" }),
        databaseUrl: fixture.databaseUrl,
        limitRules: completeRules.map((rule) =>
          rule.limitType === "rpm"
            ? ({ ...rule, limitType: "invalid" } as unknown as ApiKeyLimitRuleInput)
            : rule,
        ),
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

    // Switching limits off ignores even invalid submitted rule data and removes
    // the previously stored rules.
    await updateApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: [{ ...rpmRule, limitValue: Number.NaN }],
      limitsEnabled: false,
      virtualModels,
    });
    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 0,
      limitsEnabled: false,
    });
    await expect(listSavedApiKeyLimits(fixture.databaseUrl)).resolves.toEqual([]);

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
      limitCount: 0,
      limitsEnabled: false,
    });

    await updateApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: completeRules,
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
      limitCount: 5,
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

test("switching limits off ignores submitted ceilings and removes stored rules", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_limits_disable_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const apiKey = normalizeApiKeyFormInput({ name: "disable-with-edits" });
    const virtualModelId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
      client.query(
        `insert into virtual_models (id, name, description, enabled)
         values ($1, 'disable-vm', 'Disable VM', true)`,
        [virtualModelId],
      ),
    );
    const virtualModels = normalizeApiKeyVirtualModelSelectionInput({
      allowedVirtualModelIds: [virtualModelId],
      defaultVirtualModelId: null,
    });
    const created = await createApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      limitRules: completeRules,
      limitsEnabled: true,
      virtualModels,
    });

    // The editor shows the rules and the switch in one form. Unchecking the
    // switch ignores the submitted values and removes every stored rule.
    await updateApiKeyWithSettings({
      apiKey,
      databaseUrl: fixture.databaseUrl,
      id: created.id,
      limitRules: [{ ...rpmRule, limitValue: Number.NaN }],
      limitsEnabled: false,
      virtualModels,
    });
    await expect(listSavedApiKeyLimits(fixture.databaseUrl)).resolves.toEqual([]);
    await expectApiKeyState(fixture.databaseUrl, created.id, {
      enabled: true,
      grantCount: 1,
      limitCount: 0,
      limitsEnabled: false,
    });
  } finally {
    await fixture.dispose();
  }
});

test("a budget window is reported only for the period the key's rule is written in", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_budget_window_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const dailyRuleKeyId = randomUUID();
    const noRuleKeyId = randomUUID();
    const now = new Date("2026-07-26T12:00:00.000Z");

    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      await client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
         values ($1, 'switched-to-daily', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, true),
                ($2, 'no-budget-rule', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, true)`,
        [dailyRuleKeyId, noRuleKeyId],
      );
      // The rule says daily; the only window that exists is the monthly one the
      // key ran under before the period was changed.
      await client.query(
        `insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit)
         values ($1, $2, 'budget', 'day', 5, 'usd')`,
        [randomUUID(), dailyRuleKeyId],
      );
      await client.query(
        `insert into budget_periods (
           id, api_key_id, period_type, period_start, period_end, cost_used_usd, tokens_used
         ) values ($1, $2, 'month', $4, $5, 87.5, 1000),
                  ($3, $6, 'month', $4, $5, 12.5, 500)`,
        [
          randomUUID(),
          dailyRuleKeyId,
          randomUUID(),
          new Date("2026-07-01T00:00:00.000Z"),
          new Date("2026-08-01T00:00:00.000Z"),
          noRuleKeyId,
        ],
      );
    });

    // Pairing a month of spend with a daily ceiling renders as far over budget
    // for a key that may not have spent anything today.
    const periods = await listConsoleCurrentBudgetPeriods({
      databaseUrl: fixture.databaseUrl,
      now,
    });
    expect(periods.map((period) => period.apiKeyId)).toEqual([noRuleKeyId]);
    expect(periods[0]).toMatchObject({ costUsedUsd: "12.50000000", periodType: "month" });
  } finally {
    await fixture.dispose();
  }
});

test("an enabled limit set rejects empty fields without changing stored rules", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_limit_clearing_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const apiKeyId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
      client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
         values ($1, 'cleared-limits', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, true)`,
        [apiKeyId],
      ),
    );
    const save = (fields: Omit<Parameters<typeof normalizeApiKeyLimitFormInput>[0], "apiKeyId">) =>
      saveApiKeyLimitRules({
        databaseUrl: fixture.databaseUrl,
        limits: normalizeApiKeyLimitFormInput({ apiKeyId, ...fields }),
      });
    const savedTypes = async () =>
      (await listSavedApiKeyLimits(fixture.databaseUrl)).map((limit) => limit.limitType).sort();

    await save({
      budgetPeriod: "month",
      budgetUsd: "100",
      concurrency: "50",
      enforcementPolicy: "block",
      rpm: "600",
      tokenLimit: "200000",
      tpm: "1000000",
    });
    await expect(savedTypes()).resolves.toEqual(["budget", "concurrency", "rpm", "token", "tpm"]);

    await expect(
      save({
        budgetPeriod: "month",
        budgetUsd: "100",
        concurrency: "50",
        enforcementPolicy: "block",
        rpm: "",
        tokenLimit: "200000",
        tpm: "1000000",
      }),
    ).rejects.toThrow(/RPM limit is required/i);
    await expect(savedTypes()).resolves.toEqual(["budget", "concurrency", "rpm", "token", "tpm"]);
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
