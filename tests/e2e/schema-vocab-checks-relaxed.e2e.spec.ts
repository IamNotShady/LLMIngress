import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("schema vocab checks are relaxed while machine states remain constrained", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vocab_e2e_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await expect(
      fixture.query(
        "insert into jobs (id, job_type, status, trigger) values ($1, 'future_job_type', 'pending', 'manual')",
        [randomUUID()],
      ),
    ).resolves.toBeDefined();
    await expect(
      fixture.query(
        "insert into agents (id, name, integration_platform) values ($1, 'Vocab E2E Agent', 'future-platform')",
        [randomUUID()],
      ),
    ).resolves.toBeDefined();
    await expect(
      fixture.query(
        "insert into providers (id, provider_type, provider_key, display_name, provider_template_id) values ($1, 'api_key', 'future-provider', 'Future Provider', 'future_template')",
        [randomUUID()],
      ),
    ).resolves.toBeDefined();

    await expect(
      fixture.query(
        "insert into jobs (id, job_type, status, trigger) values ($1, 'future_job_type', 'bogus_status', 'manual')",
        [randomUUID()],
      ),
    ).rejects.toThrow(/jobs_status_check/);
  } finally {
    await fixture.dispose();
  }
});
