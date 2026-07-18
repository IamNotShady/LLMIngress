import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("extensible labels stay relaxed while persistent jobs remain core-only", async () => {
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
    ).rejects.toThrow(/jobs_job_type_check/);
    await expect(
      fixture.query(
        "insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'Vocab E2E API Key', left(gen_random_uuid()::text, 12), gen_random_uuid()::text)",
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
        "insert into jobs (id, job_type, status, trigger) values ($1, 'model_refresh', 'bogus_status', 'manual')",
        [randomUUID()],
      ),
    ).rejects.toThrow(/jobs_status_check/);
  } finally {
    await fixture.dispose();
  }
});
