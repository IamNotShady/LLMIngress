import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeAgentFormInput } from "../../packages/db/src/console-agents";
import { getOpenAICompatibleProviderTemplate } from "../../packages/db/src/console-provider-templates";
import type { TestPostgresFixture } from "../../packages/db/src/index";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

describe("schema vocab checks relaxed", () => {
  it("accepts a job_type outside the current product vocabulary", async () => {
    await withMigratedFixture(async (fixture) => {
      await expect(
        fixture.query(
          "insert into jobs (id, job_type, status, trigger) values ($1, 'future_job_type', 'pending', 'manual')",
          [randomUUID()],
        ),
      ).resolves.toBeDefined();
    });
  });

  it("accepts an agent integration_platform outside the current product vocabulary", async () => {
    await withMigratedFixture(async (fixture) => {
      await expect(
        fixture.query(
          "insert into agents (id, name, agent_type, integration_platform) values ($1, 'Vocab Agent', 'coding', 'future-platform')",
          [randomUUID()],
        ),
      ).resolves.toBeDefined();
    });
  });

  it("accepts a provider_template_id outside the current product whitelist", async () => {
    await withMigratedFixture(async (fixture) => {
      await expect(
        fixture.query(
          "insert into providers (id, provider_type, provider_key, display_name, provider_template_id) values ($1, 'api_key', 'future-provider', 'Future Provider', 'future_template')",
          [randomUUID()],
        ),
      ).resolves.toBeDefined();
    });
  });

  it("still rejects invalid machine states at the database level", async () => {
    await withMigratedFixture(async (fixture) => {
      await expect(
        fixture.query(
          "insert into jobs (id, job_type, status, trigger) values ($1, 'backup', 'bogus_status', 'manual')",
          [randomUUID()],
        ),
      ).rejects.toThrow(/jobs_status_check/);
    });
  });

  it("keeps application-layer vocabulary validation as the write-path defense", () => {
    expect(() =>
      normalizeAgentFormInput({
        agentType: "coding",
        integrationPlatform: "future-platform",
        name: "Vocab Agent",
      }),
    ).toThrow(/Agent integration platform must be/);
    expect(() => getOpenAICompatibleProviderTemplate("future_template")).toThrow(
      /whitelisted provider template/,
    );
  });
});

async function withMigratedFixture<T>(
  run: (fixture: TestPostgresFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vocab_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    return await run(fixture);
  } finally {
    await fixture.dispose();
  }
}
