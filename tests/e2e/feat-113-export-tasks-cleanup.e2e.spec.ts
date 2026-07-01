import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCostReportExportJobHandler } from "@llmingress/db/worker-cost-report-export";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createJsonlRequestLogExportJobHandler } from "@llmingress/db/worker-jsonl-export";
import { createRetentionCleanupJobHandler } from "@llmingress/db/worker-retention-cleanup";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("export metadata lives in jobs result and retention cleanup is idempotent without export_tasks", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_export_tasks_cleanup_${randomUUID().replaceAll("-", "_")}`,
  });
  const outputDir = await mkdtemp(join(tmpdir(), "llmingress-export-cleanup-"));
  const jsonlPath = join(outputDir, "request-logs.jsonl");
  const costReportPath = join(outputDir, "cost-report.json");
  const oldExportPath = join(outputDir, "old-export.jsonl");
  const newExportPath = join(outputDir, "new-export.jsonl");
  const jsonlJobId = randomUUID();
  const costReportJobId = randomUUID();
  const retentionJobId = randomUUID();
  const secondRetentionJobId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await expect(readRegclass(fixture, "export_tasks")).resolves.toBe(null);

    await insertPendingJob(fixture, {
      id: jsonlJobId,
      jobType: "jsonl_export",
      payload: { outputPath: jsonlPath, requestIds: [] },
    });
    await insertPendingJob(fixture, {
      id: costReportJobId,
      jobType: "cost_report_export",
      payload: { outputPath: costReportPath, window: "24h" },
    });

    const exportRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        cost_report_export: createCostReportExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T12:00:00.000Z"),
        }),
        jsonl_export: createJsonlRequestLogExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T12:00:00.000Z"),
        }),
      },
      workerId: "export-cleanup-worker-113",
    });

    await expect(exportRunner.runOnce()).resolves.toBe(true);
    await expect(exportRunner.runOnce()).resolves.toBe(true);
    await expect(readFile(jsonlPath, "utf8")).resolves.toBe("");
    await expect(readFile(costReportPath, "utf8")).resolves.toContain(
      '"exportType": "cost_report"',
    );
    await expect(readJobResult(fixture, jsonlJobId)).resolves.toMatchObject({
      exportType: "jsonl_request_logs",
      lineCount: 0,
      outputPath: jsonlPath,
    });
    await expect(readJobResult(fixture, costReportJobId)).resolves.toMatchObject({
      exportType: "cost_report",
      outputPath: costReportPath,
      requestCount: 0,
      window: "24h",
    });

    await writeFile(oldExportPath, '{"requestId":"old"}\n', "utf8");
    await writeFile(newExportPath, '{"requestId":"new"}\n', "utf8");
    await insertCompletedExportJob(fixture, {
      completedAt: "2026-05-01T00:00:00.000Z",
      id: randomUUID(),
      outputPath: oldExportPath,
    });
    await insertCompletedExportJob(fixture, {
      completedAt: "2026-06-01T00:00:00.000Z",
      id: randomUUID(),
      outputPath: newExportPath,
    });
    await insertPendingJob(fixture, {
      id: retentionJobId,
      jobType: "retention_cleanup",
      payload: { retentionDays: 30 },
    });
    await insertPendingJob(fixture, {
      id: secondRetentionJobId,
      jobType: "retention_cleanup",
      payload: { retentionDays: 30 },
      priority: -1,
    });

    const retentionRunner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        retention_cleanup: createRetentionCleanupJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => new Date("2026-06-16T00:00:00.000Z"),
        }),
      },
      workerId: "retention-cleanup-worker-113",
    });

    await expect(retentionRunner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, retentionJobId)).resolves.toMatchObject({
      deletedExportFileCount: 1,
      deletedExportTaskCount: 1,
    });
    await expect(pathExists(oldExportPath)).resolves.toBe(false);
    await expect(pathExists(newExportPath)).resolves.toBe(true);

    await expect(retentionRunner.runOnce()).resolves.toBe(true);
    await expect(readJobResult(fixture, secondRetentionJobId)).resolves.toMatchObject({
      deletedExportFileCount: 0,
      deletedExportTaskCount: 0,
    });
    await expect(readDeletedExportMarkerCount(fixture)).resolves.toBe(1);
  } finally {
    await fixture.dispose();
    await rm(outputDir, { force: true, recursive: true });
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

async function insertPendingJob(
  fixture: Fixture,
  input: {
    id: string;
    jobType: string;
    payload: unknown;
    priority?: number;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, priority, payload)
      values ($1, $2, 'pending', 'manual', $3, $4::jsonb)
    `,
    [input.id, input.jobType, input.priority ?? 0, JSON.stringify(input.payload)],
  );
}

async function insertCompletedExportJob(
  fixture: Fixture,
  input: {
    completedAt: string;
    id: string;
    outputPath: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, result, completed_at)
      values (
        $1,
        'jsonl_export',
        'succeeded',
        'manual',
        '{}'::jsonb,
        $2::jsonb,
        $3::timestamptz
      )
    `,
    [
      input.id,
      JSON.stringify({
        exportType: "jsonl_request_logs",
        lineCount: 1,
        outputPath: input.outputPath,
      }),
      input.completedAt,
    ],
  );
}

async function readRegclass(fixture: Fixture, relationName: string): Promise<string | null> {
  const result = await fixture.query<{ regclass: string | null }>(
    "select to_regclass($1) as regclass",
    [`public.${relationName}`],
  );
  return result.rows[0]?.regclass ?? null;
}

async function readJobResult(fixture: Fixture, jobId: string): Promise<Record<string, unknown>> {
  const result = await fixture.query<{ result: Record<string, unknown> | null }>(
    "select result from jobs where id = $1",
    [jobId],
  );
  return result.rows[0]?.result ?? {};
}

async function readDeletedExportMarkerCount(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    `
      select count(*)::text as count
      from jobs
      where result ? 'exportFileDeletedAt'
    `,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
