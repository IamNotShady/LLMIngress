import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listConsoleApiKeyVirtualModelGrants } from "../../packages/db/src/console-virtual-models.ts";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index.ts";

describe("console api key virtual model grants", () => {
  it("lists every grant with the key name and which grant is that key's default", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_grants_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const keyId = randomUUID();
      const otherKeyId = randomUUID();
      const fastId = randomUUID();
      const maxId = randomUUID();

      await fixture.query(
        `insert into virtual_models (id, name, description, enabled) values
           ($1, 'coding-fast', 'Fast', true), ($2, 'coding-max', 'Max', true)`,
        [fastId, maxId],
      );
      await fixture.query(
        `insert into api_keys (id, name, key_prefix, key_hash, default_virtual_model_id) values
           ($1, 'cursor-agent', 'llmi_a…', gen_random_uuid()::text, $3),
           ($2, 'ci-runner', 'llmi_c…', gen_random_uuid()::text, null)`,
        [keyId, otherKeyId, fastId],
      );
      await fixture.query(
        `insert into api_key_virtual_models (api_key_id, virtual_model_id) values
           ($1, $3), ($1, $4), ($2, $4)`,
        [keyId, otherKeyId, fastId, maxId],
      );

      const grants = await listConsoleApiKeyVirtualModelGrants({
        databaseUrl: fixture.databaseUrl,
      });
      const forFast = grants.filter((grant) => grant.virtualModelId === fastId);
      const forMax = grants.filter((grant) => grant.virtualModelId === maxId);

      expect(forFast.map((grant) => grant.apiKeyName)).toEqual(["cursor-agent"]);
      // The default is a column on api_keys, not a flag on the grant row.
      expect(forFast[0]?.isDefault).toBe(true);
      expect(forMax.map((grant) => grant.apiKeyName).sort()).toEqual(["ci-runner", "cursor-agent"]);
      expect(forMax.every((grant) => grant.isDefault === false)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("omits soft-deleted keys so a revoked key never looks like it still has access", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_grants_del_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const keyId = randomUUID();
      const vmId = randomUUID();
      await fixture.query(
        "insert into virtual_models (id, name, description, enabled) values ($1, 'coding-fast', 'Fast', true)",
        [vmId],
      );
      await fixture.query(
        "insert into api_keys (id, name, key_prefix, key_hash, deleted_at) values ($1, 'gone', 'llmi_g…', gen_random_uuid()::text, now())",
        [keyId],
      );
      await fixture.query(
        "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
        [keyId, vmId],
      );

      const grants = await listConsoleApiKeyVirtualModelGrants({
        databaseUrl: fixture.databaseUrl,
      });

      expect(grants).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
