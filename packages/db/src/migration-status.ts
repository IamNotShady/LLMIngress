import { PostgresClient } from "@llmingress/db/client";
import type { QueryResultRow } from "pg";

export type MigrationStatusMigration = {
  checksum: string;
  id: string;
  name: string;
};

export type AppliedMigrationStatus = {
  appliedAt: Date;
  checksum: string;
  id: string;
  name: string;
};

export type MigrationChecksumMismatch = {
  appliedChecksum: string;
  expectedChecksum: string;
  id: string;
};

export type MigrationStatusKind = "mismatch" | "pending" | "uninitialized" | "up_to_date";

export type MigrationStatusSummary = {
  appliedCount: number;
  checksumMismatches: MigrationChecksumMismatch[];
  currentSchemaVersion: string | null;
  latestMigrationId: string | null;
  latestMigrationName: string | null;
  migrateCheckHealth: {
    command: "pnpm run db:migrate:check";
    message: string;
    status: "blocked" | "ready";
  };
  pendingCount: number;
  pendingMigrations: Pick<MigrationStatusMigration, "id" | "name">[];
  status: MigrationStatusKind;
  totalCount: number;
};

type AppliedMigrationRow = QueryResultRow & {
  applied_at: Date;
  checksum: string;
  id: string;
  name: string;
};

export const shippedSqlMigrations: MigrationStatusMigration[] = [
  {
    checksum: "ad7a01ad865440fa73822362e27d68e3936620a477b060cf5cfc5fe79bf63ed8",
    id: "0001",
    name: "core_baseline",
  },
];

export async function getMigrationStatusFromDatabase(input: {
  databaseUrl?: string;
  migrations: MigrationStatusMigration[];
}): Promise<MigrationStatusSummary> {
  const client = new PostgresClient(
    input.databaseUrl ? { connectionString: input.databaseUrl } : {},
  );
  await client.connect();

  try {
    const hasMigrationHistory = await tableExists(client, "migration_history");
    const appliedMigrations = hasMigrationHistory ? await readAppliedMigrations(client) : [];
    const currentSchemaVersion = appliedMigrations.at(-1)?.id ?? null;

    return summarizeMigrationStatus({
      appliedMigrations,
      currentSchemaVersion,
      migrations: input.migrations,
    });
  } finally {
    await client.end();
  }
}

export function summarizeMigrationStatus(input: {
  appliedMigrations: AppliedMigrationStatus[];
  currentSchemaVersion: string | null;
  migrations: MigrationStatusMigration[];
}): MigrationStatusSummary {
  const appliedById = new Map(
    input.appliedMigrations.map((migration): [string, AppliedMigrationStatus] => [
      migration.id,
      migration,
    ]),
  );
  const pendingMigrations = input.migrations
    .filter((migration) => !appliedById.has(migration.id))
    .map(({ id, name }) => ({ id, name }));
  const checksumMismatches = input.migrations.flatMap((migration) => {
    const applied = appliedById.get(migration.id);
    if (!applied || applied.checksum === migration.checksum) {
      return [];
    }

    return [
      {
        appliedChecksum: applied.checksum,
        expectedChecksum: migration.checksum,
        id: migration.id,
      },
    ];
  });
  const latestMigration = input.migrations.at(-1) ?? null;
  const status = readMigrationStatusKind({
    appliedCount: input.appliedMigrations.length,
    checksumMismatches,
    currentSchemaVersion: input.currentSchemaVersion,
    pendingMigrations,
  });

  return {
    appliedCount: input.appliedMigrations.length,
    checksumMismatches,
    currentSchemaVersion: input.currentSchemaVersion,
    latestMigrationId: latestMigration?.id ?? null,
    latestMigrationName: latestMigration?.name ?? null,
    migrateCheckHealth: {
      command: "pnpm run db:migrate:check",
      message:
        checksumMismatches.length > 0
          ? "Migration validation is blocked by checksum mismatch."
          : pendingMigrations.length > 0
            ? "Migration validation can run; pending migrations remain."
            : "Migration validation can run; schema is up to date.",
      status: checksumMismatches.length > 0 ? "blocked" : "ready",
    },
    pendingCount: pendingMigrations.length,
    pendingMigrations,
    status,
    totalCount: input.migrations.length,
  };
}

export function formatMigrationStatusReport(status: MigrationStatusSummary): string {
  return [
    `Migration status: ${formatMigrationStatusKind(status.status)}`,
    `Current schema: ${status.currentSchemaVersion ?? "not initialized"}`,
    `Latest migration: ${
      status.latestMigrationId && status.latestMigrationName
        ? formatMigrationLabel(status.latestMigrationId, status.latestMigrationName)
        : "none"
    }`,
    `Applied migrations: ${status.appliedCount}/${status.totalCount}`,
    `Pending migrations: ${formatMigrationList(status.pendingMigrations)}`,
    `db:migrate:check health: ${formatMigrateCheckHealth(status)}`,
  ].join("\n");
}

function readMigrationStatusKind(input: {
  appliedCount: number;
  checksumMismatches: MigrationChecksumMismatch[];
  currentSchemaVersion: string | null;
  pendingMigrations: Pick<MigrationStatusMigration, "id" | "name">[];
}): MigrationStatusKind {
  if (input.checksumMismatches.length > 0) {
    return "mismatch";
  }
  if (input.appliedCount === 0 && input.currentSchemaVersion === null) {
    return "uninitialized";
  }
  return input.pendingMigrations.length > 0 ? "pending" : "up_to_date";
}

function formatMigrationStatusKind(status: MigrationStatusKind): string {
  return status.replaceAll("_", " ");
}

function formatMigrateCheckHealth(status: MigrationStatusSummary): string {
  const healthLabel = status.migrateCheckHealth.status === "ready" ? "Ready" : "Blocked";
  return `${healthLabel} - ${status.migrateCheckHealth.message}`;
}

function formatMigrationList(migrations: Pick<MigrationStatusMigration, "id" | "name">[]): string {
  if (migrations.length === 0) {
    return "none";
  }
  return migrations
    .map((migration) => formatMigrationLabel(migration.id, migration.name))
    .join(", ");
}

function formatMigrationLabel(id: string, name: string): string {
  return `${id}_${name}`;
}

async function tableExists(client: PostgresClient, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
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

async function readAppliedMigrations(client: PostgresClient): Promise<AppliedMigrationStatus[]> {
  const result = await client.query<AppliedMigrationRow>(
    `
      select id,
             name,
             checksum,
             applied_at
      from migration_history
      order by id
    `,
  );
  return result.rows.map((row) => ({
    appliedAt: row.applied_at,
    checksum: row.checksum,
    id: row.id,
    name: row.name,
  }));
}
