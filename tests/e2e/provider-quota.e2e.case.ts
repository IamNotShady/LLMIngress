import { randomUUID } from "node:crypto";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { createCoreMaintenanceTasks } from "@llmingress/worker-runtime/worker-maintenance-scheduler";
import { createProviderQuotaProbeJobHandler } from "@llmingress/worker-runtime/worker-provider-quota-probe";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

const encryptionKeySource = {
  kind: "inline",
  value: "provider-quota-test-key",
} as const;

type QuotaSummaryRow = {
  entries: unknown;
  error_code: string | null;
  next_refresh_at: Date | null;
  observed_at: Date;
  provider_connection_id: string;
  rows: number;
};

test("an api key quota probe stores the normalized balance entries", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_api_key_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const requestedUrls: string[] = [];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.deepseek.com",
      providerConnectionId,
      providerId,
      providerKey: "deepseek",
    });
    const before = Date.now();
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async (url, init) => {
        requestedUrls.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer deepseek-secret");
        return Response.json({
          balance_infos: [
            {
              currency: "CNY",
              granted_balance: "10.00",
              topped_up_balance: "100.00",
              total_balance: "110.00",
            },
          ],
          is_available: true,
        });
      },
    });

    await handler(quotaJob({ providerConnectionId, providerId }));

    expect(requestedUrls).toEqual(["https://api.deepseek.com/user/balance"]);
    const summary = await readQuotaSummary(fixture);
    expect(summary).toMatchObject({
      entries: [{ currency: "CNY", granted: "10.00", toppedUp: "100.00", total: "110.00" }],
      error_code: null,
      provider_connection_id: providerConnectionId,
      rows: 1,
    });
    expect(summary?.next_refresh_at?.getTime()).toBeGreaterThan(before);
    expect(summary?.next_refresh_at?.getTime()).toBeLessThanOrEqual(before + 15 * 60_000 + 5_000);
  } finally {
    await fixture.dispose();
  }
});

test("a disabled connection on an unsupported provider is canceled before any write", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_unsupported_disabled_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const disabledId = randomUUID();
  const probeOffId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      providerConnectionId: disabledId,
      providerId,
      providerKey: "google",
    });
    await fixture.query(
      `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, quota_probe_enabled)
       select $1, provider_id, 'probe-off', encrypted_key, 'probe-off-key', false
       from provider_api_keys where id = $2`,
      [probeOffId, disabledId],
    );
    await fixture.query("update provider_api_keys set enabled = false where id = $1", [disabledId]);
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async () => {
        throw new Error("A canceled quota probe must not call upstream.");
      },
    });

    // The connection state must win over the unsupported shortcut: a disabled
    // (or probing-off) connection cancels with no row, even on a Provider that
    // would otherwise persist a not_supported reason.
    await expect(
      handler(quotaJob({ providerConnectionId: disabledId, providerId })),
    ).resolves.toMatchObject({
      canceled: true,
      reason: "provider_connection_disabled_or_missing",
    });
    await expect(
      handler(quotaJob({ providerConnectionId: probeOffId, providerId })),
    ).resolves.toMatchObject({ canceled: true, reason: "quota_probe_disabled" });

    const summary = await readQuotaSummary(fixture);
    expect(summary).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
});

test("a probe racing a credential deletion does not resurrect the cleared row", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_delete_race_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.deepseek.com",
      providerConnectionId,
      providerId,
      providerKey: "deepseek",
    });
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      // The credential read has already passed when the upstream call is in
      // flight; the deletion commits underneath it, exactly like a Console
      // delete racing the Worker.
      fetch: async () => {
        await fixture.query(
          "update provider_api_keys set deleted_at = now(), updated_at = now() where id = $1",
          [providerConnectionId],
        );
        await fixture.query(
          "delete from provider_quota_summary where provider_connection_id = $1",
          [providerConnectionId],
        );
        return Response.json({
          balance_infos: [{ currency: "CNY", total_balance: "110.00" }],
          is_available: true,
        });
      },
    });

    await handler(quotaJob({ providerConnectionId, providerId }));

    const summary = await readQuotaSummary(fixture);
    expect(summary).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
});

test("an OAuth quota probe stores window entries alongside the overage balance", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_oauth_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const requestedUrls: string[] = [];

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOAuthProvider(fixture, {
      accessToken: "claude-oauth-token",
      baseUrl: "https://api.anthropic.com",
      expiresAt: Date.now() + 60 * 60_000,
      providerConnectionId,
      providerId,
      providerKey: "claude_code",
    });
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async (url, init) => {
        requestedUrls.push(String(url));
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer claude-oauth-token");
        expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
        return Response.json({
          extra_usage: {
            currency: "USD",
            is_enabled: true,
            monthly_limit: 100,
            used_credits: 23.5,
          },
          five_hour: { resets_at: "2026-07-20T12:00:00Z", utilization: 7.41 },
          seven_day: { resets_at: "2026-07-24T03:00:00Z", utilization: 53.12 },
        });
      },
    });

    await handler(quotaJob({ providerConnectionId, providerId }));

    expect(requestedUrls).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
    const summary = await readQuotaSummary(fixture);
    expect(summary).toMatchObject({
      entries: [
        { resetsAt: "2026-07-20T12:00:00Z", utilization: 0.0741, window: "five_hour" },
        { resetsAt: "2026-07-24T03:00:00Z", utilization: 0.5312, window: "seven_day" },
        { currency: "USD", total: "76.5" },
      ],
      error_code: null,
      rows: 1,
    });
  } finally {
    await fixture.dispose();
  }
});

test("a Provider that cannot report quota records its reason without any upstream call", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_unsupported_${randomUUID().replaceAll("-", "_")}`,
  });
  const googleProviderId = randomUUID();
  const googleConnectionId = randomUUID();
  const anthropicProviderId = randomUUID();
  const anthropicConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      providerConnectionId: googleConnectionId,
      providerId: googleProviderId,
      providerKey: "google",
    });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.anthropic.com/v1",
      providerConnectionId: anthropicConnectionId,
      providerId: anthropicProviderId,
      providerKey: "anthropic",
    });
    const before = Date.now();
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async () => {
        throw new Error("An unsupported Provider must not be probed upstream.");
      },
    });

    await handler(
      quotaJob({ providerConnectionId: googleConnectionId, providerId: googleProviderId }),
    );
    await handler(
      quotaJob({ providerConnectionId: anthropicConnectionId, providerId: anthropicProviderId }),
    );

    const summaries = await fixture.query<{
      entries: unknown;
      error_code: string;
      next_refresh_at: Date;
      provider_id: string;
    }>(
      `
        select provider_id::text, entries, error_code, next_refresh_at
        from provider_quota_summary
        order by error_code
      `,
    );
    expect(summaries.rows).toMatchObject([
      { entries: [], error_code: "not_supported", provider_id: googleProviderId },
      {
        entries: [],
        error_code: "requires_separate_credential",
        provider_id: anthropicProviderId,
      },
    ]);
    for (const row of summaries.rows) {
      expect(row.next_refresh_at.getTime()).toBeGreaterThan(before + 23 * 60 * 60_000);
    }
  } finally {
    await fixture.dispose();
  }
});

test("a rejected credential records unauthorized and backs off an hour", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_unauthorized_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.openai.com/v1",
      providerConnectionId,
      providerId,
      providerKey: "openai",
    });
    const before = Date.now();
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async () => Response.json({ error: { message: "forbidden" } }, { status: 403 }),
    });

    await handler(quotaJob({ providerConnectionId, providerId }));

    const summary = await readQuotaSummary(fixture);
    expect(summary).toMatchObject({ entries: [], error_code: "unauthorized", rows: 1 });
    expect(summary?.next_refresh_at?.getTime()).toBeGreaterThanOrEqual(
      before + 60 * 60_000 - 5_000,
    );
    expect(summary?.next_refresh_at?.getTime()).toBeLessThanOrEqual(before + 60 * 60_000 + 5_000);
  } finally {
    await fixture.dispose();
  }
});

test("a probe that throws on a malformed base URL is recorded rather than retried", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_malformed_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "not-a-url",
      providerConnectionId,
      providerId,
      providerKey: "zai",
    });
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async () => {
        throw new Error("A malformed base URL must fail before any upstream call.");
      },
    });

    const result = await handler(quotaJob({ providerConnectionId, providerId }));

    expect(result).toMatchObject({ errorCode: "probe_failed" });
    const summary = await readQuotaSummary(fixture);
    expect(summary).toMatchObject({ entries: [], error_code: "probe_failed", rows: 1 });
  } finally {
    await fixture.dispose();
  }
});

test("a connection with quota probing disabled is canceled and writes no row", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_disabled_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.deepseek.com",
      providerConnectionId,
      providerId,
      providerKey: "deepseek",
    });
    await fixture.query("update provider_api_keys set quota_probe_enabled = false where id = $1", [
      providerConnectionId,
    ]);
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async () => {
        throw new Error("A disabled connection must not be probed.");
      },
    });

    const result = await handler(quotaJob({ providerConnectionId, providerId }));

    expect(result).toEqual({ canceled: true, reason: "quota_probe_disabled" });
    const rows = await fixture.query<{ rows: number }>(
      "select count(*)::int as rows from provider_quota_summary",
    );
    expect(rows.rows[0]?.rows).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

test("an expired OAuth token is refreshed, written back, and used for the probe", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_oauth_refresh_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const encryption = createSecretEncryption(encryptionKeySource);
  let probeAuthorization: string | null = null;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const stored = await seedOAuthProvider(fixture, {
      accessToken: "expired-token",
      baseUrl: "https://api.anthropic.com",
      expiresAt: Date.now() - 60_000,
      providerConnectionId,
      providerId,
      providerKey: "claude_code",
      refreshToken: "refresh-token",
    });
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async (url, init) => {
        if (String(url) === "https://api.anthropic.com/v1/oauth/token") {
          return Response.json({
            access_token: "refreshed-token",
            expires_in: 3600,
            refresh_token: "refresh-token",
            token_type: "Bearer",
          });
        }
        probeAuthorization = new Headers(init?.headers).get("authorization");
        return Response.json({ five_hour: { utilization: 25 } });
      },
    });

    await handler(quotaJob({ providerConnectionId, providerId }));

    expect(probeAuthorization).toBe("Bearer refreshed-token");
    const summary = await readQuotaSummary(fixture);
    expect(summary).toMatchObject({
      entries: [{ utilization: 0.25, window: "five_hour" }],
      error_code: null,
      rows: 1,
    });
    const credential = await fixture.query<{ access_token: string; encrypted_token: unknown }>(
      "select encrypted_token from provider_oauth where id = $1",
      [providerConnectionId],
    );
    expect(credential.rows[0]?.encrypted_token).not.toEqual(stored);
    expect(
      JSON.parse(
        encryption.decrypt(
          credential.rows[0]?.encrypted_token as Parameters<typeof encryption.decrypt>[0],
        ),
      ),
    ).toMatchObject({ accessToken: "refreshed-token" });
  } finally {
    await fixture.dispose();
  }
});

test("a quota probe cannot overwrite a token rotated while its refresh is in flight", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_oauth_race_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const encryption = createSecretEncryption(encryptionKeySource);
  const rotated = encryption.encrypt(
    JSON.stringify({
      accessToken: "rotated-token",
      expiresAt: null,
      refreshToken: "rotated-refresh-token",
      scopes: [],
      tokenType: "Bearer",
    }),
  );

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOAuthProvider(fixture, {
      accessToken: "expired-token",
      baseUrl: "https://api.anthropic.com",
      expiresAt: Date.now() - 60_000,
      providerConnectionId,
      providerId,
      providerKey: "claude_code",
      refreshToken: "refresh-token",
    });
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async (url) => {
        if (String(url) === "https://api.anthropic.com/v1/oauth/token") {
          await fixture.query(
            "update provider_oauth set encrypted_token = $2::jsonb, updated_at = now() where id = $1",
            [providerConnectionId, JSON.stringify(rotated)],
          );
          return Response.json({
            access_token: "refreshed-token",
            expires_in: 3600,
            refresh_token: "refresh-token",
            token_type: "Bearer",
          });
        }
        throw new Error("A lost refresh race must not probe upstream.");
      },
    });

    const result = await handler(quotaJob({ providerConnectionId, providerId }));

    expect(result).toEqual({
      canceled: true,
      reason: "provider_connection_changed_during_oauth_refresh",
    });
    const state = await fixture.query<{ encrypted_token: unknown; summaries: number }>(
      `
        select encrypted_token,
               (select count(*)::int from provider_quota_summary) as summaries
        from provider_oauth
        where id = $1
      `,
      [providerConnectionId],
    );
    expect(state.rows[0]).toEqual({ encrypted_token: rotated, summaries: 0 });
  } finally {
    await fixture.dispose();
  }
});

test("repeated probes upsert one row per connection and advance observed_at", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_upsert_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  let total = "10.00";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.deepseek.com",
      providerConnectionId,
      providerId,
      providerKey: "deepseek",
    });
    const handler = createProviderQuotaProbeJobHandler({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource,
      fetch: async () =>
        Response.json({ balance_infos: [{ currency: "CNY", total_balance: total }] }),
    });

    await handler(quotaJob({ providerConnectionId, providerId }));
    const first = await readQuotaSummary(fixture);
    total = "9.00";
    await handler(quotaJob({ providerConnectionId, providerId }));
    const second = await readQuotaSummary(fixture);

    expect(second).toMatchObject({
      entries: [{ currency: "CNY", total: "9.00" }],
      rows: 1,
    });
    expect(second?.observed_at.getTime()).toBeGreaterThanOrEqual(
      first?.observed_at.getTime() ?? Number.POSITIVE_INFINITY,
    );
  } finally {
    await fixture.dispose();
  }
});

test("the maintenance task enqueues due connections exactly once", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_schedule_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const providerConnectionId = randomUUID();
  const disabledConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedApiKeyProvider(fixture, {
      baseUrl: "https://api.deepseek.com",
      providerConnectionId,
      providerId,
      providerKey: "deepseek",
    });
    await seedApiKey(fixture, { providerConnectionId: disabledConnectionId, providerId });
    await fixture.query("update provider_api_keys set quota_probe_enabled = false where id = $1", [
      disabledConnectionId,
    ]);

    const task = createCoreMaintenanceTasks({ databaseUrl: fixture.databaseUrl }).find(
      (candidate) => candidate.id === "provider-quota-probe-enqueue",
    );
    expect(task).toBeDefined();
    await task?.run(new AbortController().signal);
    await task?.run(new AbortController().signal);

    const jobs = await fixture.query<{
      provider_connection_id: string;
      provider_id: string;
      source: string;
      status: string;
    }>(
      `
        select payload ->> 'providerId' as provider_id,
               payload ->> 'providerConnectionId' as provider_connection_id,
               payload ->> 'source' as source,
               status
        from jobs
        where job_type = 'provider_quota_probe'
      `,
    );
    expect(jobs.rows).toEqual([
      {
        provider_connection_id: providerConnectionId,
        provider_id: providerId,
        source: "scheduled_probe",
        status: "pending",
      },
    ]);

    await fixture.query(
      `
        insert into provider_quota_summary (id, provider_id, provider_connection_id, next_refresh_at)
        values ($1, $2, $3, now() + interval '1 hour')
      `,
      [randomUUID(), providerId, providerConnectionId],
    );
    await fixture.query(
      "update jobs set status = 'succeeded' where job_type = 'provider_quota_probe'",
    );
    await task?.run(new AbortController().signal);

    const pending = await fixture.query<{ pending: number }>(
      `
        select count(*)::int as pending
        from jobs
        where job_type = 'provider_quota_probe'
          and status = 'pending'
      `,
    );
    expect(pending.rows[0]?.pending).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

function quotaJob(input: {
  id?: string;
  providerConnectionId: string;
  providerId: string;
  source?: "manual_probe" | "scheduled_probe";
  trigger?: "manual" | "scheduled" | "system";
}) {
  return {
    attemptNumber: 1,
    id: input.id ?? randomUUID(),
    jobType: "provider_quota_probe",
    maxAttempts: 3,
    payload: {
      providerConnectionId: input.providerConnectionId,
      providerId: input.providerId,
      source: input.source ?? "scheduled_probe",
    },
    priority: 0,
    signal: new AbortController().signal,
    trigger: input.trigger ?? "system",
    workerId: "provider-quota-test",
  };
}

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

async function seedApiKeyProvider(
  fixture: Fixture,
  input: {
    baseUrl: string;
    providerConnectionId: string;
    providerId: string;
    providerKey: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $3, $4, true)
    `,
    [input.providerId, input.providerKey, `${input.providerKey} quota`, input.baseUrl],
  );
  await seedApiKey(fixture, {
    plaintext: `${input.providerKey}-secret`,
    providerConnectionId: input.providerConnectionId,
    providerId: input.providerId,
  });
}

async function seedApiKey(
  fixture: Fixture,
  input: { plaintext?: string; providerConnectionId: string; providerId: string },
): Promise<void> {
  const plaintext = input.plaintext ?? "quota-secret";
  const encrypted = createSecretEncryption(encryptionKeySource).encrypt(plaintext);
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4::jsonb, $5)
    `,
    [
      input.providerConnectionId,
      input.providerId,
      plaintext.slice(0, 8),
      JSON.stringify(encrypted),
      encrypted.keyId,
    ],
  );
}

async function seedOAuthProvider(
  fixture: Fixture,
  input: {
    accessToken: string;
    baseUrl: string;
    expiresAt: number | null;
    providerConnectionId: string;
    providerId: string;
    providerKey: string;
    refreshToken?: string;
  },
): Promise<unknown> {
  const encrypted = createSecretEncryption(encryptionKeySource).encrypt(
    JSON.stringify({
      accessToken: input.accessToken,
      expiresAt: input.expiresAt,
      refreshToken: input.refreshToken ?? null,
      scopes: [],
      tokenType: "Bearer",
    }),
  );
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'subscription', $2, $3, $4, true)
    `,
    [input.providerId, input.providerKey, `${input.providerKey} quota`, input.baseUrl],
  );
  await fixture.query(
    `
      insert into provider_oauth (
        id, provider_id, encrypted_token, token_expires_at, completed_at
      )
      values ($1, $2, $3::jsonb, $4, now())
    `,
    [
      input.providerConnectionId,
      input.providerId,
      JSON.stringify(encrypted),
      input.expiresAt === null ? null : new Date(input.expiresAt),
    ],
  );
  return encrypted;
}

async function readQuotaSummary(fixture: Fixture): Promise<QuotaSummaryRow | undefined> {
  const result = await fixture.query<QuotaSummaryRow>(
    `
      select provider_connection_id::text,
             entries,
             observed_at,
             next_refresh_at,
             error_code,
             (select count(*)::int from provider_quota_summary) as rows
      from provider_quota_summary
      limit 1
    `,
  );
  return result.rows[0];
}
