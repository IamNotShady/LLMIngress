import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupJobHandler } from "@llmingress/db/worker-backup";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createPostgresPeriodicScheduler } from "@llmingress/db/worker-periodic-scheduler";
import { expect, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";

test("manual and scheduled backup jobs create artifact for config operational tables and pre migration use", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_backup_job_${randomUUID().replaceAll("-", "_")}`,
  });
  const preMigrationFixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_backup_pre_migration_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-backup-job-"));
  const manualOutputPath = join(outputDir, "manual-backup.json");
  const scheduledOutputPath = join(outputDir, "scheduled-backup.json");
  const preMigrationOutputPath = join(outputDir, "pre-migration-backup.json");
  const now = new Date("2026-06-16T12:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedBackupData(fixture);
    await insertManualBackupJob(fixture, {
      outputPath: manualOutputPath,
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        backup: createBackupJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      workerId: "backup-worker-086",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => new Date("2026-06-16T12:00:00.000Z"),
      tasks: [
        {
          id: "backup",
          intervalMs: 24 * 60 * 60 * 1000,
          jobType: "backup",
          maxAttempts: 1,
          payload: {
            outputPath: scheduledOutputPath,
          },
          priority: -10,
          startAt: new Date("2026-06-16T00:00:00.000Z"),
        },
      ],
    });
    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 1,
      deduplicatedJobs: 0,
      skippedTasks: 0,
    });
    await expect(runner.runOnce()).resolves.toBe(true);

    const manualBackup = await readBackupArtifact(manualOutputPath);
    const scheduledBackup = await readBackupArtifact(scheduledOutputPath);
    expect(manualBackup).toMatchObject({
      createdAt: "2026-06-16T12:00:00.000Z",
      kind: "llmingress.backup",
      mode: "manual",
      version: 1,
    });
    expect(scheduledBackup).toMatchObject({
      createdAt: "2026-06-16T12:00:00.000Z",
      kind: "llmingress.backup",
      mode: "scheduled",
      version: 1,
    });
    expect(manualBackup.tables.config.agents).toHaveLength(1);
    expect(manualBackup.tables.config.agent_virtual_models).toHaveLength(1);
    expect(manualBackup.tables.config.providers).toHaveLength(1);
    expect(manualBackup.tables.config.provider_api_keys).toHaveLength(1);
    expect(manualBackup.tables.config).not.toHaveProperty("agent_api_keys");
    expect(manualBackup.tables.operational.request_activity).toHaveLength(1);
    expect(manualBackup.tables.operational.request_usage).toHaveLength(1);
    expect(manualBackup.tables.operational.jobs.length).toBeGreaterThanOrEqual(1);
    expect(scheduledBackup.tables.operational.jobs.length).toBeGreaterThanOrEqual(2);
    expect(manualBackup.tableCounts.providers).toBe(1);
    expect(manualBackup.tableCounts.request_activity).toBe(1);
    expect(JSON.stringify(manualBackup)).toContain("ciphertext-backup-086");
    expect(JSON.stringify(manualBackup)).toContain("sha256:v1:backup-agent-key-hash-086");

    await expect(readBackupJobs(fixture)).resolves.toEqual([
      {
        result: expect.objectContaining({
          mode: "manual",
          outputPath: manualOutputPath,
          tableCount: expect.any(Number),
        }),
        status: "succeeded",
        trigger: "manual",
      },
      {
        result: expect.objectContaining({
          mode: "scheduled",
          outputPath: scheduledOutputPath,
          tableCount: expect.any(Number),
        }),
        status: "succeeded",
        trigger: "scheduled",
      },
    ]);

    await applyPreMigrationSchema(preMigrationFixture);
    await seedPreMigrationConfig(preMigrationFixture);
    const cliResult = spawnSync(
      "pnpm",
      [
        "run",
        "db:backup",
        "--",
        "--database-url",
        preMigrationFixture.databaseUrl,
        "--output-path",
        preMigrationOutputPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      },
    );
    expect(cliResult.status, cliResult.stderr || cliResult.stdout).toBe(0);
    expect(cliResult.stdout).toContain("Backup artifact written");
    const preMigrationBackup = await readBackupArtifact(preMigrationOutputPath);
    expect(preMigrationBackup).toMatchObject({
      kind: "llmingress.backup",
      mode: "pre_migration",
      version: 1,
    });
    expect(preMigrationBackup.tables.config.providers).toHaveLength(1);
    expect(preMigrationBackup.skippedTables).toContain("jobs");
    expect(preMigrationBackup.skippedTables).toContain("request_activity");
  } finally {
    await fixture.dispose();
    await preMigrationFixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type BackupArtifact = {
  createdAt: string;
  kind: "llmingress.backup";
  mode: "manual" | "pre_migration" | "scheduled";
  skippedTables: string[];
  tableCounts: Record<string, number>;
  tables: {
    config: Record<string, unknown[]>;
    operational: Record<string, unknown[]>;
    system: Record<string, unknown[]>;
  };
  version: 1;
};

async function readBackupArtifact(outputPath: string): Promise<BackupArtifact> {
  return JSON.parse(await readFile(outputPath, "utf8")) as BackupArtifact;
}

async function seedBackupData(fixture: Fixture): Promise<void> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    providerApiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    requestActivityId: randomUUID(),
    routePolicyId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (
        id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled
      )
      values ($1, 'api_key', 'deepseek', 'deepseek', 'Backup DeepSeek',
              'https://api.deepseek.com', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id, provider_id, model_id, display_name, context_window, supports_streaming,
        supports_tools, availability
      )
      values ($1, $2, 'deepseek-chat', 'DeepSeek Chat', 64000, true, true, 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, 'sk-backup86',
              '{"ciphertext":"ciphertext-backup-086","iv":"iv","tag":"tag"}'::jsonb,
              'provider-key-id-backup-086')
    `,
    [ids.providerApiKeyId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'backup-fast', 'Backup Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
    [ids.routePolicyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id, route_policy_id, provider_model_id, candidate_order
      )
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), ids.routePolicyId, ids.providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Backup Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_bak86', key_hash = 'sha256:v1:backup-agent-key-hash-086', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [ids.agentApiKeyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        status,
        http_status,
        started_at,
        completed_at,
        created_at
      )
      values (
        $1,
        'req_backup_086',
        $2,
        $3,
        $4,
        $5,
        'llmi_bak86',
        'chat_completions',
        'backup-fast',
        false,
        'succeeded',
        200,
        '2026-06-16T11:59:00.000Z'::timestamptz,
        '2026-06-16T11:59:01.000Z'::timestamptz,
        '2026-06-16T11:59:00.000Z'::timestamptz
      )
    `,
    [
      ids.requestActivityId,
      ids.agentApiKeyId,
      ids.virtualModelId,
      ids.providerId,
      ids.providerModelId,
    ],
  );
  await fixture.query(
    `
      insert into request_usage (
        id,
        request_activity_id,
        agent_id,
        virtual_model_id,
        provider_model_id,
        input_tokens,
        output_tokens,
        total_tokens,
        token_source
      )
      values ($1, $2, $3, $4, $5, 10, 20, 30, 'estimated')
    `,
    [
      randomUUID(),
      ids.requestActivityId,
      ids.agentApiKeyId,
      ids.virtualModelId,
      ids.providerModelId,
    ],
  );
}

async function insertManualBackupJob(
  fixture: Fixture,
  input: {
    outputPath: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'backup', 'pending', 'manual', $2::jsonb, 1)
    `,
    [
      randomUUID(),
      JSON.stringify({
        outputPath: input.outputPath,
      }),
    ],
  );
}

async function readBackupJobs(fixture: Fixture) {
  const result = await fixture.query<{
    result: unknown;
    status: string;
    trigger: string;
  }>(
    `
      select status, trigger, result
      from jobs
      where job_type = 'backup'
      order by trigger, created_at
    `,
  );
  return result.rows;
}

async function applyPreMigrationSchema(fixture: Fixture): Promise<void> {
  const migrations = loadSqlMigrations().filter((migration) =>
    ["0001", "0002"].includes(migration.id),
  );
  for (const migration of migrations) {
    await fixture.query(migration.sql);
  }
}

async function seedPreMigrationConfig(fixture: Fixture): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Pre Migration OpenAI',
              'https://api.openai.com/v1', true)
    `,
    [randomUUID()],
  );
}
