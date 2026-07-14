import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  getMigrationStatus,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src";

test("platform migrates an empty database and reports schema status", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_v1_platform_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const migrations = loadSqlMigrations();
    const firstRun = await runMigrations({ databaseUrl: fixture.databaseUrl });
    const secondRun = await runMigrations({ databaseUrl: fixture.databaseUrl });

    expect(firstRun.applied.map((migration) => migration.id)).toEqual(
      migrations.map((migration) => migration.id),
    );
    expect(secondRun).toMatchObject({ applied: [], skipped: migrations });

    await expect(getMigrationStatus({ databaseUrl: fixture.databaseUrl })).resolves.toMatchObject({
      appliedCount: migrations.length,
      pendingCount: 0,
      status: "up_to_date",
    });
    const foreignKeys = await fixture.query<{ foreign_key_count: string }>(
      `
        select count(*)::text as foreign_key_count
        from pg_constraint
        where contype = 'f'
          and connamespace = 'public'::regnamespace
      `,
    );
    expect(Number(foreignKeys.rows[0]?.foreign_key_count ?? 0)).toBe(0);

    const cliResult = spawnSync(
      "pnpm",
      ["run", "db:migrate:status", "--", "--database-url", fixture.databaseUrl],
      { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 30_000 },
    );
    expect(cliResult.status, cliResult.stderr || cliResult.stdout).toBe(0);
    expect(cliResult.stdout).toContain("Migration status: up to date");
    expect(cliResult.stdout).toContain("db:migrate:check health: Ready");
  } finally {
    await fixture.dispose();
  }
});
