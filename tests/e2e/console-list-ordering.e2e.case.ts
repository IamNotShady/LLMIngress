import { randomUUID } from "node:crypto";
import { listApiKeys } from "@llmingress/db/console-api-keys";
import { listConsoleActivities } from "@llmingress/db/console-activity";
import { listProviders } from "@llmingress/db/console-providers";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("console entity lists return newly created records first", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_list_order_${randomUUID().replaceAll("-", "_")}`,
  });
  const older = "2026-07-27T00:00:00.000Z";
  const newer = "2026-07-28T00:00:00.000Z";
  const olderApiKeyId = randomUUID();
  const newerApiKeyId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (
          id, provider_type, provider_key, display_name, created_at, updated_at
        )
        values
          ($1, 'api_key', 'z-older-provider', 'Older Provider', $3, $3),
          ($2, 'api_key', 'a-newer-provider', 'Newer Provider', $4, $4)
      `,
      [randomUUID(), randomUUID(), older, newer],
    );
    await fixture.query(
      `
        insert into api_keys (
          id, name, key_prefix, key_hash, created_at, updated_at
        )
        values
          ($1, 'z-older-key', 'llmi_older', 'hash-older', $3, $3),
          ($2, 'a-newer-key', 'llmi_newer', 'hash-newer', $4, $4)
      `,
      [olderApiKeyId, newerApiKeyId, older, newer],
    );
    await fixture.query(
      `
        insert into virtual_models (
          id, name, description, enabled, created_at, updated_at
        )
        values
          (gen_random_uuid(), 'z-older-model', 'Older Model', true, $1, $1),
          (gen_random_uuid(), 'a-newer-model', 'Newer Model', true, $2, $2)
      `,
      [older, newer],
    );
    await fixture.query(
      `
        insert into request_activity (
          id,
          request_id,
          api_key_id,
          api_key_prefix,
          protocol,
          status,
          started_at,
          created_at
        )
        values
          (gen_random_uuid(), 'older-created', $1, 'llmi_older', 'chat_completions', 'succeeded', $4, $3),
          (gen_random_uuid(), 'newer-created', $2, 'llmi_newer', 'chat_completions', 'succeeded', $3, $4)
      `,
      [olderApiKeyId, newerApiKeyId, older, newer],
    );

    await expect(listProviders(fixture.databaseUrl)).resolves.toMatchObject([
      { displayName: "Newer Provider" },
      { displayName: "Older Provider" },
    ]);
    await expect(listApiKeys(fixture.databaseUrl)).resolves.toMatchObject([
      { name: "a-newer-key" },
      { name: "z-older-key" },
    ]);
    await expect(listVirtualModels(fixture.databaseUrl)).resolves.toMatchObject([
      { name: "a-newer-model" },
      { name: "z-older-model" },
    ]);
    await expect(
      listConsoleActivities({ databaseUrl: fixture.databaseUrl }),
    ).resolves.toMatchObject([{ requestId: "newer-created" }, { requestId: "older-created" }]);
  } finally {
    await fixture.dispose();
  }
});
