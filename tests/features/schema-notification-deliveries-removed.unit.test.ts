import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestPostgresFixture } from "../../packages/db/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createBackupArtifact } from "../../packages/db/src/worker-backup";
import {
  createNotificationDispatchJobHandler,
  queueNotificationEvent,
} from "../../packages/db/src/worker-notification-dispatcher";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("schema notification deliveries removed", () => {
  it("updates notification_events without a deliveries table", async () => {
    await withMigratedFixture(async (fixture) => {
      const channelId = await seedNotificationChannel(fixture);
      const queued = await queueNotificationEvent({
        channelIds: [channelId],
        databaseUrl: fixture.databaseUrl,
        event: {
          body: "Body",
          eventType: "fallback_exhaustion",
          maxAttempts: 2,
          subject: "Subject",
        },
        now: () => new Date("2026-07-05T00:00:00.000Z"),
      });
      await fixture.query("drop table if exists notification_deliveries");

      const handler = createNotificationDispatchJobHandler({
        databaseUrl: fixture.databaseUrl,
        deliverWebhook: async () => ({
          errorCode: "webhook_http_error",
          errorMessage: "Webhook returned HTTP 500.",
          responseStatus: 500,
          status: "failed",
        }),
        now: () => new Date("2026-07-05T00:00:01.000Z"),
        retryBackoffMs: () => 1_000,
      });

      await expect(
        handler({
          attemptNumber: 1,
          id: randomUUID(),
          jobType: "notification_dispatch",
          maxAttempts: 3,
          payload: {},
          priority: 0,
          trigger: "system",
          workerId: "worker-schema-notifications",
        }),
      ).resolves.toMatchObject({ processed: 1, retrying: 1 });

      await expect(readNotificationEvent(fixture, queued.eventIds[0])).resolves.toMatchObject({
        attempt_count: 1,
        last_error_code: "webhook_http_error",
        status: "retrying",
      });
    });
  });

  it("migrated schema has no notification_deliveries table", async () => {
    await withMigratedFixture(async (fixture) => {
      await expect(tableExists(fixture, "notification_deliveries")).resolves.toBe(false);
    });
  });

  it("backup artifact no longer lists notification_deliveries", async () => {
    await withMigratedFixture(async (fixture) => {
      const directory = await mkdtemp(join(tmpdir(), "llmingress-backup-"));
      createdDirectories.push(directory);
      const outputPath = join(directory, "backup.json");

      await createBackupArtifact({
        databaseUrl: fixture.databaseUrl,
        mode: "manual",
        now: new Date("2026-07-05T00:00:00.000Z"),
        outputPath,
      });

      const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
        skippedTables: string[];
        tables: { operational: Record<string, unknown[]> };
      };
      expect(Object.keys(artifact.tables.operational)).not.toContain("notification_deliveries");
      expect(artifact.skippedTables).not.toContain("notification_deliveries");
    });
  });
});

async function withMigratedFixture<T>(
  run: (fixture: TestPostgresFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_notifications_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    return await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function seedNotificationChannel(fixture: TestPostgresFixture): Promise<string> {
  const channelId = randomUUID();
  await fixture.query(
    `
      insert into notification_channels (id, channel_type, display_name, enabled, config)
      values ($1, 'webhook', 'Schema Hook', true, '{"url":"http://127.0.0.1:9/webhook"}'::jsonb)
    `,
    [channelId],
  );
  return channelId;
}

async function readNotificationEvent(fixture: TestPostgresFixture, eventId?: string) {
  const result = await fixture.query<{
    attempt_count: number;
    last_error_code: string | null;
    status: string;
  }>(
    `
      select attempt_count, last_error_code, status
      from notification_events
      where id = $1
    `,
    [eventId],
  );
  return result.rows[0];
}

async function tableExists(fixture: TestPostgresFixture, tableName: string): Promise<boolean> {
  const result = await fixture.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
          and table_type = 'BASE TABLE'
      )
    `,
    [tableName],
  );
  return result.rows[0]?.exists ?? false;
}
