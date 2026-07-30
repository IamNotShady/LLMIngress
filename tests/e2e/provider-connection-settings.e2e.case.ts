import { randomUUID } from "node:crypto";
import {
  saveProviderApiKey,
  updateProviderApiKeySettings,
} from "@llmingress/db/console-provider-keys";
import { updateProviderOAuthConnectionSettings } from "@llmingress/db/providers";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

const encryptionKey = "a".repeat(64);

/**
 * Editing a connection without pasting a new secret takes its own path, and it
 * has to hold the same rules as saving one: an operator renaming a connection
 * is not an operator with more authority over what a label or a priority may
 * be. Priority orders the routing fallback and the column is an integer.
 */
test("editing a connection holds the label and priority rules the paste path holds", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_connection_settings_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const oauthId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'openai', 'Connection Settings', 'https://provider.test/v1', true)`,
      [providerId],
    );
    await fixture.query(
      `insert into provider_oauth (id, provider_id, label, priority, encrypted_token, completed_at)
       values ($1, $2, 'authorized', 10, '{}'::jsonb, now())`,
      [oauthId, providerId],
    );
    const saved = await saveProviderApiKey({
      databaseUrl: fixture.databaseUrl,
      encryptionKeySource: { kind: "inline", value: encryptionKey },
      label: "first",
      plaintext: "sk-connection-settings-value",
      priority: 10,
      providerId,
    });
    const settings = (overrides: { label?: string | null; priority?: number }) =>
      updateProviderApiKeySettings({
        databaseUrl: fixture.databaseUrl,
        enabled: true,
        label: "renamed",
        priority: 20,
        providerApiKeyId: saved.metadata.id,
        ...overrides,
      });

    await expect(settings({ priority: 9999 })).rejects.toThrow(/between 0 and 100/);
    await expect(settings({ priority: -1 })).rejects.toThrow(/between 0 and 100/);
    // A fractional priority would silently become a different integer in the
    // column, so it is refused rather than rounded to something unasked for.
    await expect(settings({ priority: 50.5 })).rejects.toThrow(/between 0 and 100/);
    await expect(settings({ label: "x".repeat(101) })).rejects.toThrow(/at most 100 characters/);

    // A refused edit changes nothing: the connection is still what it was.
    const untouched = await fixture.query<{ label: string; priority: number }>(
      `select label, priority from provider_api_keys where id = $1`,
      [saved.metadata.id],
    );
    expect(untouched.rows[0]).toEqual({ label: "first", priority: 10 });

    await expect(settings({ label: " trimmed ", priority: 0 })).resolves.toMatchObject({
      enabled: true,
    });
    const accepted = await fixture.query<{ label: string; priority: number }>(
      `select label, priority from provider_api_keys where id = $1`,
      [saved.metadata.id],
    );
    expect(accepted.rows[0]).toEqual({ label: "trimmed", priority: 0 });

    // An authorized connection is edited through its own function, and the
    // rules do not change because the credential is a token.
    const oauthSettings = (priority: number) =>
      updateProviderOAuthConnectionSettings({
        databaseUrl: fixture.databaseUrl,
        enabled: true,
        label: "renamed",
        priority,
        providerOAuthId: oauthId,
      });
    await expect(oauthSettings(9999)).rejects.toThrow(/between 0 and 100/);
    await expect(oauthSettings(30)).resolves.toMatchObject({ priority: 30 });
  } finally {
    await fixture.dispose();
  }
});
