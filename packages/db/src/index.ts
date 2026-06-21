import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import {
  type AppliedMigrationStatus,
  type MigrationStatusSummary,
  summarizeMigrationStatus,
} from "./migration-status.js";

export type { PostgresQueryClient, PostgresQueryResult } from "./client.js";
export { withPostgresClient } from "./client.js";
export type {
  AppliedMigrationStatus,
  MigrationChecksumMismatch,
  MigrationStatusKind,
  MigrationStatusMigration,
  MigrationStatusSummary,
} from "./migration-status.js";
export {
  formatMigrationStatusReport,
  getMigrationStatusFromDatabase,
  shippedSqlMigrations,
  summarizeMigrationStatus,
} from "./migration-status.js";
export type {
  NormalizedProviderModelRefreshInput,
  ProviderModelRefreshInput,
  QueuedProviderModelRefreshJob,
} from "./provider-jobs.js";
export {
  buildJobCreatedNotificationPayload,
  buildModelRefreshJobPayload,
  enqueueProviderConnectivityCheckJob,
  enqueueProviderModelRefreshJob,
  normalizeProviderModelRefreshInput,
} from "./provider-jobs.js";

type TestPostgresEnvironment = Record<string, string | undefined>;

type TestPostgresFixtureOptions = {
  env?: TestPostgresEnvironment;
  maintenanceUrl?: string;
  databaseNamePrefix?: string;
};

export type TestPostgresFixture = {
  databaseName: string;
  databaseUrl: string;
  migrate: () => Promise<void>;
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<QueryResult<T>>;
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type SqlMigration = {
  id: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
};

type LoadSqlMigrationsOptions = {
  migrationsDirectory?: string;
};

type RunMigrationsOptions = {
  databaseUrl: string;
  migrationsDirectory?: string;
};

export type MigrationRunResult = {
  applied: SqlMigration[];
  skipped: SqlMigration[];
};

type GetMigrationStatusOptions = {
  databaseUrl: string;
  migrationsDirectory?: string;
};

type AppliedMigrationRow = QueryResultRow & {
  applied_at: Date;
  checksum: string;
  id: string;
  name: string;
};

const migrationFilePattern = /^(\d{4,})_([a-z0-9][a-z0-9_]*)\.sql$/;
const migrationAdvisoryLockId = 7_790_077;

export function readTestDatabaseUrl(env: TestPostgresEnvironment = process.env): string {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required for PostgreSQL fixture tests.");
  }
  return url;
}

export function buildIsolatedDatabaseUrl(maintenanceUrl: string, databaseName: string): string {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function getDefaultMigrationsDirectory(): string {
  return findMigrationsDirectory(process.cwd());
}

export function loadSqlMigrations(options: LoadSqlMigrationsOptions = {}): SqlMigration[] {
  const migrationsDirectory = options.migrationsDirectory ?? getDefaultMigrationsDirectory();
  const seenIds = new Set<string>();

  return readdirSync(/* turbopackIgnore: true */ migrationsDirectory)
    .filter((filename) => filename.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const parsed = parseMigrationFilename(filename);
      if (seenIds.has(parsed.id)) {
        throw new Error(`Duplicate migration id: ${parsed.id}`);
      }
      seenIds.add(parsed.id);

      const fullPath = join(/* turbopackIgnore: true */ migrationsDirectory, filename);
      const sql = readFileSync(/* turbopackIgnore: true */ fullPath, "utf8");

      return {
        ...parsed,
        filename,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunResult> {
  const migrations = loadSqlMigrations({
    migrationsDirectory: options.migrationsDirectory,
  });

  return withClient(options.databaseUrl, async (client) => {
    await client.query("begin");

    try {
      await client.query("select pg_advisory_xact_lock($1)", [migrationAdvisoryLockId]);
      await client.query(createMigrationHistoryTableSql);

      const appliedRows = await client.query<{ id: string; checksum: string }>(
        "select id, checksum from migration_history",
      );
      const appliedChecksums = new Map(
        appliedRows.rows.map((row): [string, string] => [row.id, row.checksum]),
      );
      const applied: SqlMigration[] = [];
      const skipped: SqlMigration[] = [];

      for (const migration of migrations) {
        const existingChecksum = appliedChecksums.get(migration.id);
        if (existingChecksum === migration.checksum) {
          skipped.push(migration);
          continue;
        }

        if (existingChecksum) {
          throw new Error(`Migration ${migration.id} checksum mismatch.`);
        }

        await client.query(migration.sql);
        await client.query(
          `
            insert into migration_history (id, name, checksum)
            values ($1, $2, $3)
          `,
          [migration.id, migration.name, migration.checksum],
        );
        applied.push(migration);
      }

      await client.query("commit");
      return { applied, skipped };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function getMigrationStatus(
  options: GetMigrationStatusOptions,
): Promise<MigrationStatusSummary> {
  const migrations = loadSqlMigrations({
    migrationsDirectory: options.migrationsDirectory,
  });

  return withClient(options.databaseUrl, async (client) => {
    const hasMigrationHistory = await tableExists(client, "migration_history");
    const appliedMigrations = hasMigrationHistory ? await readAppliedMigrations(client) : [];
    const currentSchemaVersion = appliedMigrations.at(-1)?.id ?? null;

    return summarizeMigrationStatus({
      appliedMigrations,
      currentSchemaVersion,
      migrations,
    });
  });
}

export async function createTestPostgresFixture(
  options: TestPostgresFixtureOptions = {},
): Promise<TestPostgresFixture> {
  const maintenanceUrl = options.maintenanceUrl ?? readTestDatabaseUrl(options.env);
  const databaseName = createDatabaseName(options.databaseNamePrefix ?? "llmingress_test");
  const databaseUrl = buildIsolatedDatabaseUrl(maintenanceUrl, databaseName);

  await withClient(maintenanceUrl, async (client) => {
    await client.query(`create database ${quoteIdentifier(databaseName)}`);
  });

  return new PostgresFixture(maintenanceUrl, databaseName, databaseUrl);
}

class PostgresFixture implements TestPostgresFixture {
  private client: Client | undefined;

  constructor(
    private readonly maintenanceUrl: string,
    readonly databaseName: string,
    readonly databaseUrl: string,
  ) {}

  async migrate(): Promise<void> {
    const client = await this.getClient();
    await client.query(`
      create table if not exists fixture_items (
        id serial primary key,
        label text not null
      )
    `);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const client = await this.getClient();
    return client.query<T>(text, values ? [...values] : undefined);
  }

  async reset(): Promise<void> {
    const client = await this.getClient();
    const tables = await client.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
      order by table_name
    `);

    if (tables.rows.length === 0) {
      return;
    }

    const tableList = tables.rows.map((row) => quoteIdentifier(row.table_name)).join(", ");
    await client.query(`truncate table ${tableList} restart identity cascade`);
  }

  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = undefined;
    }

    await withClient(this.maintenanceUrl, async (client) => {
      await client.query(
        `
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = $1
            and pid <> pg_backend_pid()
        `,
        [this.databaseName],
      );
      await client.query(`drop database if exists ${quoteIdentifier(this.databaseName)}`);
    });
  }

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.client = new Client({ connectionString: this.databaseUrl });
      await this.client.connect();
    }
    return this.client;
  }
}

function createDatabaseName(prefix: string): string {
  const suffix = randomUUID().replaceAll("-", "_").slice(0, 12);
  assertSafeIdentifierPrefix(prefix);
  const name = `${prefix.slice(0, 50)}_${suffix}`;
  assertSafeIdentifier(name);
  return name;
}

function quoteIdentifier(identifier: string): string {
  assertSafeIdentifier(identifier);
  return `"${identifier}"`;
}

function assertSafeIdentifier(identifier: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
}

function assertSafeIdentifierPrefix(identifier: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier prefix: ${identifier}`);
  }
}

function findMigrationsDirectory(startDirectory: string): string {
  const candidates = [
    join(/* turbopackIgnore: true */ startDirectory, "packages/db/migrations"),
    join(/* turbopackIgnore: true */ startDirectory, "../../packages/db/migrations"),
    join(/* turbopackIgnore: true */ startDirectory, "migrations"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? join(startDirectory, "packages/db/migrations");
}

async function withClient<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function parseMigrationFilename(filename: string): Pick<SqlMigration, "id" | "name"> {
  const match = migrationFilePattern.exec(filename);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }

  return {
    id: match[1],
    name: match[2],
  };
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
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

async function readAppliedMigrations(client: Client): Promise<AppliedMigrationStatus[]> {
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

const createMigrationHistoryTableSql = `
  create table if not exists migration_history (
    id text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now()
  )
`;
