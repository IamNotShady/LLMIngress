import { readFileSync } from "node:fs";
import { Client, type ClientConfig } from "pg";

type DatabaseUrlEnvironment = Record<string, string | undefined>;

type ReadPostgresDatabaseUrlOptions = {
  configFilePath?: string;
  env?: DatabaseUrlEnvironment;
};

type BootstrapConfigFile = {
  databaseUrl?: string;
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

export function readPostgresDatabaseUrl(options: ReadPostgresDatabaseUrlOptions = {}): string {
  const env = options.env ?? process.env;
  const configFilePath = options.configFilePath ?? env.LLMINGRESS_BOOTSTRAP_CONFIG;
  const fileConfig = configFilePath ? readBootstrapConfigFile(configFilePath) : {};
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

export async function withPostgresClient<T>(
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T>;
export async function withPostgresClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T>;
export async function withPostgresClient<T>(
  databaseUrlOrOperation: string | undefined | ((client: PostgresQueryClient) => Promise<T>),
  maybeOperation?: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const databaseUrl =
    typeof databaseUrlOrOperation === "function" ? undefined : databaseUrlOrOperation;
  const operation =
    typeof databaseUrlOrOperation === "function" ? databaseUrlOrOperation : maybeOperation;
  if (!operation) {
    throw new Error("withPostgresClient requires an operation.");
  }

  const client = new PostgresClient(databaseUrl ? { connectionString: databaseUrl } : {});
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function readBootstrapConfigFile(path: string): BootstrapConfigFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BootstrapConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LLMINGRESS_BOOTSTRAP_CONFIG could not be read: ${message}`);
  }
}
