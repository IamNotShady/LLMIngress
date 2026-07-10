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
    checksum: "1b894e463ec7a3297f78f313ec476104390121725c5c700c837f75ba6517e5de",
    id: "0001",
    name: "v1_baseline",
  },
  {
    checksum: "cec33c998433f2bac833da83f04e2481ef6e62419a46009a094c2dc6a3338fe2",
    id: "0002",
    name: "stale_concurrency_job_type",
  },
  {
    checksum: "3861906dac167fc9b71d8be0359564000d560f17240b7e4f4ac6f3a56103a3d1",
    id: "0003",
    name: "remove_budget_reservations",
  },
  {
    checksum: "b49690f559aa4cc3faf2ca13d4925394751fbd351635c5ac5b6c0b65c9b16a89",
    id: "0004",
    name: "relax_vocab_checks",
  },
  {
    checksum: "6996ebfcbce4e4715d3019344a91627da8eaf209af693d3c74782d46670786f2",
    id: "0005",
    name: "drop_notification_deliveries",
  },
  {
    checksum: "0e8ef3395df6a9c2583b9380542305717b6568d80ea248321d68323803430992",
    id: "0006",
    name: "fallback_single_source",
  },
  {
    checksum: "9cf3cd316246b7813211d04a35a764724b19c8bca3ad8aeaecc4112d0378ea78",
    id: "0007",
    name: "drop_foreign_keys",
  },
  {
    checksum: "559d7442ae3a9aaa2e14bb33157d0ce10abf17dfdb194bb9c286700948cfd406",
    id: "0008",
    name: "provider_dependency_lookup",
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
