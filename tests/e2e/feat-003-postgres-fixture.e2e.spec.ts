import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture } from "../../packages/db/src/index";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "TEST_DATABASE_URL is required for PostgreSQL fixture E2E",
);

test("postgres fixture migrates resets and prevents leaked rows", async () => {
  const first = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_e2e_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await first.migrate();
    await first.query("insert into fixture_items (label) values ($1)", ["first"]);

    const inserted = await first.query<{ count: string }>("select count(*) from fixture_items");
    expect(inserted.rows[0]?.count).toBe("1");

    await first.reset();

    const afterReset = await first.query<{ count: string }>("select count(*) from fixture_items");
    expect(afterReset.rows[0]?.count).toBe("0");
  } finally {
    await first.dispose();
  }

  const second = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_e2e_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await second.migrate();

    const leaked = await second.query<{ count: string }>("select count(*) from fixture_items");
    expect(leaked.rows[0]?.count).toBe("0");
  } finally {
    await second.dispose();
  }
});
