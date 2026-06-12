import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture } from "../../packages/db/src/index";

test("migration runner creates schema version and rerun is idempotent", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_migrate_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const firstRun = runMigrateCommand(fixture.databaseUrl);
    expect(firstRun.status, firstRun.stderr || firstRun.stdout).toBe(0);
    expect(firstRun.stdout).toContain("Applied 1 migration");

    const schemaVersion = await fixture.query<{ version: string }>(
      "select version from schema_version where id = 1",
    );
    expect(schemaVersion.rows).toEqual([{ version: "0001" }]);

    const historyAfterFirstRun = await fixture.query<{ id: string; name: string; count: string }>(`
      select id, name, count(*) over ()::text as count
      from migration_history
      order by id
    `);
    expect(historyAfterFirstRun.rows).toEqual([
      { id: "0001", name: "create_schema_version", count: "1" },
    ]);

    const secondRun = runMigrateCommand(fixture.databaseUrl);
    expect(secondRun.status, secondRun.stderr || secondRun.stdout).toBe(0);
    expect(secondRun.stdout).toContain("Applied 0 migrations");

    const historyAfterSecondRun = await fixture.query<{ count: string }>(
      "select count(*)::text as count from migration_history",
    );
    expect(historyAfterSecondRun.rows).toEqual([{ count: "1" }]);
  } finally {
    await fixture.dispose();
  }
});

function runMigrateCommand(databaseUrl: string) {
  return spawnSync("pnpm", ["run", "db:migrate", "--", "--database-url", databaseUrl], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
}
