import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { createBackupArtifact } from "../../apps/worker/src/backup";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";

test("runtime schema no longer creates or keeps process_heartbeats", async () => {
  const freshFixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_no_process_hb_${randomUUID().replaceAll("-", "_")}`,
  });
  const upgradeFixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_drop_process_hb_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-feat101-backup-"));
  const backupPath = join(outputDir, "fresh-backup.json");

  try {
    await runMigrations({ databaseUrl: freshFixture.databaseUrl });

    await expect(tableExists(freshFixture, "process_heartbeats")).resolves.toBe(false);
    await insertGatewayRuntimeStatus(freshFixture);

    await createBackupArtifact({
      databaseUrl: freshFixture.databaseUrl,
      mode: "manual",
      now: new Date("2026-06-17T00:00:00.000Z"),
      outputPath: backupPath,
    });
    const backup = await readBackupArtifact(backupPath);
    expect(backup.tables.operational).not.toHaveProperty("process_heartbeats");
    expect(backup.skippedTables).not.toContain("process_heartbeats");

    await applyMigrationsThrough(upgradeFixture, "0024");
    await expect(tableExists(upgradeFixture, "process_heartbeats")).resolves.toBe(true);
    await upgradeFixture.query(
      `
        insert into process_heartbeats (
          id, process_type, process_id, status, metadata
        )
        values ($1, 'worker', 'worker-feat-101', 'running', '{"legacy":true}'::jsonb)
      `,
      [randomUUID()],
    );

    await runMigrations({ databaseUrl: upgradeFixture.databaseUrl });

    await expect(tableExists(upgradeFixture, "process_heartbeats")).resolves.toBe(false);
    await expect(readLatestAppliedMigrationId(upgradeFixture)).resolves.toBe(
      loadSqlMigrations().at(-1)?.id,
    );
    await expect(readAppliedMigration(upgradeFixture, "0025")).resolves.toEqual({
      id: "0025",
      name: "remove_process_heartbeats",
    });
  } finally {
    await freshFixture.dispose();
    await upgradeFixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type BackupArtifact = {
  skippedTables: string[];
  tables: {
    operational: Record<string, unknown[]>;
  };
};

async function applyMigrationsThrough(fixture: Fixture, targetId: string): Promise<void> {
  const client = new Client({ connectionString: fixture.databaseUrl });
  await client.connect();

  try {
    for (const migration of loadSqlMigrations()) {
      if (migration.id > targetId) {
        break;
      }

      await client.query(migration.sql);
      await client.query(
        `
          insert into migration_history (id, name, checksum)
          values ($1, $2, $3)
        `,
        [migration.id, migration.name, migration.checksum],
      );
    }
  } finally {
    await client.end();
  }
}

async function insertGatewayRuntimeStatus(fixture: Fixture): Promise<void> {
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'feat-101 runtime status check')",
  );
  await fixture.query(
    `
      insert into gateway_runtime_status (
        id, gateway_instance_id, status, applied_config_version, heartbeat_at, started_at
      )
      values ($1, 'gateway-feat-101', 'ready', 1, now(), now())
    `,
    [randomUUID()],
  );
}

async function readAppliedMigration(
  fixture: Fixture,
  id: string,
): Promise<{ id: string; name: string } | undefined> {
  const result = await fixture.query<{ id: string; name: string }>(
    "select id, name from migration_history where id = $1",
    [id],
  );
  return result.rows[0];
}

async function readBackupArtifact(outputPath: string): Promise<BackupArtifact> {
  return JSON.parse(await readFile(outputPath, "utf8")) as BackupArtifact;
}

async function readLatestAppliedMigrationId(fixture: Fixture): Promise<string | undefined> {
  const result = await fixture.query<{ id: string }>(
    "select id from migration_history order by id desc limit 1",
  );
  return result.rows[0]?.id;
}

async function tableExists(fixture: Fixture, tableName: string): Promise<boolean> {
  const result = await fixture.query<{ exists: boolean }>(
    "select to_regclass($1)::text is not null as exists",
    [`public.${tableName}`],
  );
  return result.rows[0]?.exists ?? false;
}
