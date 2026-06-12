import { randomUUID } from "node:crypto";
import { Client, type QueryResult, type QueryResultRow } from "pg";

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
