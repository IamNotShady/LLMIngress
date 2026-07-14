import { afterAll, describe, expect, it } from "vitest";
import {
  closePostgresPools,
  getPostgresPool,
  withPostgresTransaction,
} from "../../packages/db/src/client";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("gateway db pool", () => {
  afterAll(async () => {
    await getPostgresPool(databaseUrl).query("drop table if exists pool_tx_probe");
    await closePostgresPools();
  });

  it("returns the same pool instance for the same connection string", () => {
    expect(getPostgresPool(databaseUrl)).toBe(getPostgresPool(databaseUrl));
  });

  it("bounds concurrent connections at the configured max", async () => {
    const pool = getPostgresPool(databaseUrl);
    await Promise.all(Array.from({ length: 50 }, () => pool.query("select pg_sleep(0.01)")));
    expect(pool.totalCount).toBeLessThanOrEqual(10);
  });

  it("rolls back the transaction when the operation throws", async () => {
    await getPostgresPool(databaseUrl).query("create table if not exists pool_tx_probe (id int)");
    await expect(
      withPostgresTransaction(databaseUrl, async (client) => {
        await client.query("insert into pool_tx_probe values (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await getPostgresPool(databaseUrl).query<{ n: number }>(
      "select count(*)::int as n from pool_tx_probe",
    );
    expect(result.rows[0]?.n).toBe(0);
  });
});
