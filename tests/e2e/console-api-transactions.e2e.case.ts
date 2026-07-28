import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { updateProviderApiKeySettings } from "../../packages/db/src/console-provider-keys";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  replaceProviderOAuthDevicePendingConnection,
  updateProviderOAuthConnectionSettings,
} from "../../packages/db/src/providers";

test("provider connection settings roll back together when a later database write fails", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_tx_${randomUUID().replaceAll("-", "_")}`,
  });
  const apiKeyProviderId = randomUUID();
  const apiKeyConnectionId = randomUUID();
  const oauthProviderId = randomUUID();
  const oauthConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, enabled)
        values
          ($1, 'api_key', 'tx-api-key', 'Transaction API key', true),
          ($2, 'subscription', 'tx-oauth', 'Transaction OAuth', true)
      `,
      [apiKeyProviderId, oauthProviderId],
    );
    await fixture.query(
      `
        insert into provider_api_keys (
          id, provider_id, key_prefix, encrypted_key, key_id, label, priority,
          quota_probe_enabled
        )
        values ($1, $2, 'tx-key', '{}'::jsonb, 'tx-key-id', 'before api key', 10, false)
      `,
      [apiKeyConnectionId, apiKeyProviderId],
    );
    await fixture.query(
      `
        insert into provider_oauth (
          id, provider_id, label, priority, encrypted_token, completed_at,
          quota_probe_enabled
        )
        values ($1, $2, 'before oauth', 20, '{}'::jsonb, now(), false)
      `,
      [oauthConnectionId, oauthProviderId],
    );
    await fixture.query(
      `
        insert into provider_quota_summary (
          id, provider_id, provider_connection_id, entries, next_refresh_at
        )
        values
          ($1, $2, $3, '[]'::jsonb, now() + interval '1 hour'),
          ($4, $5, $6, '[]'::jsonb, now() + interval '1 hour')
      `,
      [
        randomUUID(),
        apiKeyProviderId,
        apiKeyConnectionId,
        randomUUID(),
        oauthProviderId,
        oauthConnectionId,
      ],
    );
    await fixture.query(`
      create function refuse_quota_schedule_update() returns trigger
      language plpgsql as $$
      begin
        raise exception 'forced later write failure';
      end
      $$;
      create trigger refuse_quota_schedule_update
      before update on provider_quota_summary
      for each row execute function refuse_quota_schedule_update();
    `);

    await expect(
      updateProviderApiKeySettings({
        databaseUrl: fixture.databaseUrl,
        enabled: false,
        label: "after api key",
        priority: 90,
        providerApiKeyId: apiKeyConnectionId,
        quotaProbeEnabled: true,
      }),
    ).rejects.toThrow("forced later write failure");
    await expect(
      updateProviderOAuthConnectionSettings({
        databaseUrl: fixture.databaseUrl,
        enabled: false,
        label: "after oauth",
        priority: 80,
        providerOAuthId: oauthConnectionId,
        quotaProbeEnabled: true,
      }),
    ).rejects.toThrow("forced later write failure");

    const apiKey = await fixture.query<{
      enabled: boolean;
      label: string;
      priority: number;
      quota_probe_enabled: boolean;
    }>(
      `
        select enabled, label, priority, quota_probe_enabled
        from provider_api_keys
        where id = $1
      `,
      [apiKeyConnectionId],
    );
    expect(apiKey.rows[0]).toEqual({
      enabled: true,
      label: "before api key",
      priority: 10,
      quota_probe_enabled: false,
    });

    const oauth = await fixture.query<{
      enabled: boolean;
      label: string;
      priority: number;
      quota_probe_enabled: boolean;
    }>(
      `
        select enabled, label, priority, quota_probe_enabled
        from provider_oauth
        where id = $1
      `,
      [oauthConnectionId],
    );
    expect(oauth.rows[0]).toEqual({
      enabled: true,
      label: "before oauth",
      priority: 20,
      quota_probe_enabled: false,
    });
  } finally {
    await fixture.dispose();
  }
});

test("replacing a device OAuth pending connection keeps the old row if the insert fails", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_device_tx_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const oldConnectionId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, enabled)
        values ($1, 'subscription', 'tx-device', 'Transaction Device OAuth', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_oauth (
          id, provider_id, label, flow_type, pending_state, pending_expires_at,
          pending_user_code, pending_verification_uri, pending_interval_seconds
        )
        values (
          $1, $2, 'old pending', 'device_code', 'old-state', now() + interval '10 minutes',
          'OLD-CODE', 'https://example.com/device', 5
        )
      `,
      [oldConnectionId, providerId],
    );
    await fixture.query(`
      create function refuse_new_device_pending() returns trigger
      language plpgsql as $$
      begin
        if new.pending_state = 'new-state' then
          raise exception 'forced pending insert failure';
        end if;
        return new;
      end
      $$;
      create trigger refuse_new_device_pending
      before insert on provider_oauth
      for each row execute function refuse_new_device_pending();
    `);

    await expect(
      replaceProviderOAuthDevicePendingConnection({
        databaseUrl: fixture.databaseUrl,
        intervalSeconds: 5,
        label: "new pending",
        pendingCodeChallenge: "new-challenge",
        pendingCodeVerifier: "new-verifier",
        pendingExpiresAt: new Date(Date.now() + 10 * 60_000),
        pendingState: "new-state",
        priority: 30,
        providerId,
        userCode: "NEW-CODE",
        verificationUri: "https://example.com/device",
      }),
    ).rejects.toThrow("forced pending insert failure");

    const pending = await fixture.query<{ id: string; label: string; pending_state: string }>(
      `
        select id::text, label, pending_state
        from provider_oauth
        where provider_id = $1
          and completed_at is null
          and deleted_at is null
      `,
      [providerId],
    );
    expect(pending.rows).toEqual([
      {
        id: oldConnectionId,
        label: "old pending",
        pending_state: "old-state",
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});
