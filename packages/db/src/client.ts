import { readBootstrapDatabaseUrlConfigFile } from "@llmingress/config";
import { createLogger } from "@llmingress/logging";
import { Client, type ClientConfig, Pool } from "pg";

const logger = createLogger("db");

type DatabaseUrlEnvironment = Record<string, string | undefined>;

type ReadPostgresDatabaseUrlOptions = {
  configFilePath?: string;
  env?: DatabaseUrlEnvironment;
};

export class PostgresClient extends Client {
  constructor(config: ClientConfig = {}) {
    super({
      ...config,
      connectionString: config.connectionString ?? readPostgresDatabaseUrl(),
    });
  }
}

export type PostgresQueryResultRow = Record<string, unknown>;

export type PostgresQueryResult<T = Record<string, unknown>> = {
  rowCount?: number | null;
  rows: T[];
};

export type PostgresQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<PostgresQueryResult<T>>;
};

const postgresPools = new Map<string, Pool>();

export function readPostgresDatabaseUrl(options: ReadPostgresDatabaseUrlOptions = {}): string {
  const env = options.env ?? process.env;
  const configFilePath = options.configFilePath ?? env.LLMINGRESS_BOOTSTRAP_CONFIG;
  const fileConfig = configFilePath ? readBootstrapDatabaseUrlConfigFile(configFilePath) : {};
  const databaseUrl = env.DATABASE_URL ?? fileConfig.databaseUrl;

  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is required.");
  }

  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error("protocol must be postgresql:");
    }
    return databaseUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DATABASE_URL is invalid: ${message}`);
  }
}

export function assertPostgresDatabaseConfigured(
  options: ReadPostgresDatabaseUrlOptions = {},
): void {
  readPostgresDatabaseUrl(options);
}

export function getPostgresPool(databaseUrl?: string): Pool {
  const connectionString = databaseUrl?.trim() || readPostgresDatabaseUrl();
  const existing = postgresPools.get(connectionString);
  if (existing) {
    return existing;
  }

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: llmingressDbPoolMax(),
  });
  pool.on("error", (error) => {
    logger.error({ err: error }, "postgres pool error");
  });
  postgresPools.set(connectionString, pool);
  return pool;
}

export async function closePostgresPools(): Promise<void> {
  const pools = [...postgresPools.values()];
  postgresPools.clear();
  await Promise.all(pools.map((pool) => pool.end()));
}

export async function closePostgresPool(databaseUrl?: string): Promise<void> {
  const connectionString = databaseUrl?.trim() || readPostgresDatabaseUrl();
  const pool = postgresPools.get(connectionString);
  if (!pool) {
    return;
  }

  postgresPools.delete(connectionString);
  await pool.end();
}

export async function withPooledPostgresClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const client = await getPostgresPool(databaseUrl).connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    await client.query("begin");
    try {
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  });
}

export async function withDedicatedPostgresClient<T>(
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T>;
export async function withDedicatedPostgresClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T>;
export async function withDedicatedPostgresClient<T>(
  databaseUrlOrOperation: string | undefined | ((client: PostgresQueryClient) => Promise<T>),
  maybeOperation?: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const databaseUrl =
    typeof databaseUrlOrOperation === "function" ? undefined : databaseUrlOrOperation;
  const operation =
    typeof databaseUrlOrOperation === "function" ? databaseUrlOrOperation : maybeOperation;
  if (!operation) {
    throw new Error("withDedicatedPostgresClient requires an operation.");
  }

  const client = new PostgresClient(databaseUrl ? { connectionString: databaseUrl } : {});
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function llmingressDbPoolMax(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.LLMINGRESS_DB_POOL_MAX ?? "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
}
