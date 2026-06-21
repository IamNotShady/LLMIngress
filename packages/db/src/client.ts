import { Client } from "pg";

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

export async function withPostgresClient<T>(
  databaseUrl: string,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
