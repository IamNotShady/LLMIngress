import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/client";
import type { JobHandler } from "./worker-job-runner.ts";

export type BackupMode = "manual" | "pre_migration" | "scheduled";

export type BackupSettings = {
  intervalMs: number;
  outputDir: string;
};

export type BackupJobPayload = {
  mode: "manual" | "scheduled";
  outputPath: string;
};

export type BackupArtifact = {
  createdAt: string;
  kind: "llmingress.backup";
  mode: BackupMode;
  skippedTables: string[];
  tableCounts: Record<string, number>;
  tables: Record<BackupTableGroup, Record<string, Record<string, unknown>[]>>;
  version: 1;
};

export type BackupArtifactResult = {
  mode: BackupMode;
  outputPath: string;
  rowCount: number;
  skippedTableCount: number;
  tableCount: number;
  tableCounts: Record<string, number>;
};

type CreateBackupJobHandlerOptions = {
  databaseUrl?: string;
  now?: () => Date;
};

type CreateBackupArtifactOptions = {
  databaseUrl?: string;
  mode: BackupMode;
  now?: Date;
  outputPath: string;
};

type TableRow = PostgresQueryResultRow & {
  table_name: string;
};

type ColumnRow = PostgresQueryResultRow & {
  column_name: string;
};

type BackupTableGroup = "config" | "operational" | "system";

const dayMs = 24 * 60 * 60 * 1000;
const defaultBackupIntervalMs = dayMs;
const defaultBackupOutputDir = ".llmingress/backups";

const backupTableGroups: Record<BackupTableGroup, readonly string[]> = {
  config: [
    "providers",
    "provider_models",
    "provider_api_keys",
    "provider_oauth",
    "agents",
    "virtual_models",
    "route_policies",
    "route_policy_candidates",
    "agent_virtual_models",
    "agent_limits",
    "config_versions",
    "notification_channels",
  ],
  operational: [
    "rate_limit_windows",
    "budget_periods",
    "request_activity",
    "request_usage",
    "request_costs",
    "fallback_events",
    "budget_reservations",
    "jobs",
    "job_attempts",
    "provider_health_events",
    "provider_health_summary",
    "gateway_runtime_status",
    "runtime_errors",
    "notification_events",
    "notification_deliveries",
    "webhook_deliveries",
  ],
  system: ["migration_history", "console_admins", "console_sessions"],
};

export function createBackupJobHandler(options: CreateBackupJobHandlerOptions): JobHandler {
  return async (job) => {
    const now = options.now?.() ?? new Date();
    const payload = readBackupJobPayload(job.payload, now, job.trigger);
    return createBackupArtifact({
      databaseUrl: options.databaseUrl,
      mode: payload.mode,
      now,
      outputPath: payload.outputPath,
    });
  };
}

export async function createBackupArtifact(
  options: CreateBackupArtifactOptions,
): Promise<BackupArtifactResult> {
  const now = options.now ?? new Date();
  const client = new PostgresClient({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const existingTables = await readExistingTables(client);
    const tables: BackupArtifact["tables"] = {
      config: {},
      operational: {},
      system: {},
    };
    const skippedTables: string[] = [];
    const tableCounts: Record<string, number> = {};

    for (const group of Object.keys(backupTableGroups) as BackupTableGroup[]) {
      for (const tableName of backupTableGroups[group]) {
        if (!existingTables.has(tableName)) {
          skippedTables.push(tableName);
          continue;
        }

        const rows = await readTableRows(client, tableName);
        tables[group][tableName] = rows;
        tableCounts[tableName] = rows.length;
      }
    }
    await client.query("commit");

    const artifact: BackupArtifact = {
      createdAt: now.toISOString(),
      kind: "llmingress.backup",
      mode: options.mode,
      skippedTables,
      tableCounts,
      tables,
      version: 1,
    };

    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    return {
      mode: options.mode,
      outputPath: options.outputPath,
      rowCount: Object.values(tableCounts).reduce((sum, count) => sum + count, 0),
      skippedTableCount: skippedTables.length,
      tableCount: Object.keys(tableCounts).length,
      tableCounts,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function readBackupSettings(
  env: Partial<Record<string, string | undefined>> = process.env,
): BackupSettings {
  return {
    intervalMs: readPositiveIntegerEnv(
      env.BACKUP_INTERVAL_MS,
      defaultBackupIntervalMs,
      "BACKUP_INTERVAL_MS",
    ),
    outputDir: readNonEmptyStringEnv(
      env.BACKUP_OUTPUT_DIR,
      defaultBackupOutputDir,
      "BACKUP_OUTPUT_DIR",
    ),
  };
}

export function readBackupJobPayload(
  payload: unknown,
  now: Date,
  trigger: string,
): BackupJobPayload {
  const rawPayload = readObject(payload);
  const mode = trigger === "scheduled" ? "scheduled" : "manual";
  const timestamp = mode === "scheduled" ? (readScheduleWindowStart(rawPayload) ?? now) : now;
  const outputPath =
    readOptionalString(rawPayload.outputPath) ??
    buildBackupOutputPath(
      readOptionalString(rawPayload.outputDir) ?? readBackupSettings().outputDir,
      mode,
      timestamp,
    );

  return {
    mode,
    outputPath,
  };
}

export function buildBackupOutputPath(outputDir: string, mode: BackupMode, now: Date): string {
  return join(outputDir, `llmingress-backup-${mode}-${formatBackupTimestamp(now)}.json`);
}

function formatBackupTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function readExistingTables(client: PostgresClient): Promise<Set<string>> {
  const result = await client.query<TableRow>(
    `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `,
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function readTableRows(
  client: PostgresClient,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const columns = await readTableColumns(client, tableName);
  const columnList = columns.map(quoteIdentifier).join(", ");
  const orderBy = columns.includes("id") ? " order by id" : "";
  const result = await client.query<Record<string, unknown>>(
    `select ${columnList} from ${quoteIdentifier(tableName)}${orderBy}`,
  );
  return result.rows;
}

async function readTableColumns(client: PostgresClient, tableName: string): Promise<string[]> {
  const result = await client.query<ColumnRow>(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position
    `,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readScheduleWindowStart(payload: Record<string, unknown>): Date | undefined {
  const schedule = readObject(payload.schedule);
  const windowStart = readOptionalString(schedule.windowStart);
  if (!windowStart) {
    return undefined;
  }

  const parsed = new Date(windowStart);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function readPositiveIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function readNonEmptyStringEnv(
  value: string | undefined,
  defaultValue: string,
  name: string,
): string {
  if (value === undefined) {
    return defaultValue;
  }
  if (value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}
