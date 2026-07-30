import { randomUUID } from "node:crypto";
import { createTestPostgresFixture, loadSqlMigrations, runMigrations } from "@llmingress/db";

async function main(): Promise<void> {
  const migrations = loadSqlMigrations();
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_migrate_check_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    const firstRun = await runMigrations({ databaseUrl: fixture.databaseUrl });
    if (firstRun.applied.length !== migrations.length) {
      throw new Error(
        `Expected ${migrations.length} migration(s) to apply, applied ${firstRun.applied.length}.`,
      );
    }

    const secondRun = await runMigrations({ databaseUrl: fixture.databaseUrl });
    if (secondRun.applied.length !== 0 || secondRun.skipped.length !== migrations.length) {
      throw new Error(
        `Expected rerun to apply 0 and skip ${migrations.length}; ` +
          `applied ${secondRun.applied.length}, skipped ${secondRun.skipped.length}.`,
      );
    }

    console.log(
      `Migration check passed: applied ${firstRun.applied.length}; ` +
        `rerun skipped ${secondRun.skipped.length}.`,
    );
  } finally {
    await fixture.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
