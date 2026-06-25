import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  CONFIG_CHANGED_CHANNEL,
  createConfigChangedListener,
  createConfigPublisher,
} from "../../packages/config/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("config publisher commits data and version in one transaction and sends one notify", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_config_pub_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    const notifications: unknown[] = [];
    const listener = await createConfigChangedListener({
      databaseUrl: fixture.databaseUrl,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });

    try {
      const providerId = randomUUID();
      const publisher = createConfigPublisher({
        databaseUrl: fixture.databaseUrl,
      });

      const result = await publisher.publish({
        source: "console",
        description: "Create routing-visible provider",
        changes: [{ table: "providers", recordId: providerId }],
        write: async (client) => {
          await client.query(
            "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
            [providerId, "api_key", "openai", "OpenAI", true],
          );
        },
      });

      await expect.poll(() => notifications.length).toBe(1);
      expect(notifications).toEqual([
        {
          channel: CONFIG_CHANGED_CHANNEL,
          version: result.version,
          configVersionId: result.configVersionId,
          source: "console",
          changeCount: 1,
        },
      ]);

      const committed = await fixture.query<{
        changes: unknown;
        provider_count: string;
        version_count: string;
      }>(
        `
          select
            (select count(*)::text from providers where id = $1) as provider_count,
            (select count(*)::text from config_versions where version = $2 and source = 'console') as version_count,
            (select changes from config_versions where id = $3::bigint) as changes
        `,
        [providerId, result.version, result.configVersionId],
      );
      expect(committed.rows[0]).toMatchObject({
        provider_count: "1",
        version_count: "1",
      });
      expect(committed.rows[0]?.changes).toEqual([
        {
          createdAt: expect.any(String),
          id: result.changes[0]?.id,
          recordId: providerId,
          source: "console",
          table: "providers",
        },
      ]);

      await expect(
        publisher.publish({
          source: "console",
          description: "Rollback failed provider write",
          changes: [{ table: "providers", recordId: randomUUID() }],
          write: async (client) => {
            await client.query(
              "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
              [randomUUID(), "api_key", "bad-provider", "Bad Provider", true],
            );
            throw new Error("stop config write");
          },
        }),
      ).rejects.toThrow(/stop config write/);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(notifications).toHaveLength(1);
      const rolledBack = await fixture.query<{ provider_count: string; version_count: string }>(`
        select
          (select count(*)::text from providers where provider_key = 'bad-provider') as provider_count,
          (select count(*)::text from config_versions where version = 2) as version_count
      `);
      expect(rolledBack.rows).toEqual([{ provider_count: "0", version_count: "0" }]);
    } finally {
      await listener.close();
    }
  } finally {
    await fixture.dispose();
  }
});
