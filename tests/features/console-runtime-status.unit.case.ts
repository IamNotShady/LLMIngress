import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withDedicatedPostgresClient } from "../../packages/db/src/client.ts";
import {
  consoleWorkerJobTypes,
  getConsoleRuntimeStatus,
} from "../../packages/db/src/console-runtime-status.ts";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index.ts";

describe("console runtime status", () => {
  it("reports the database server version and every worker job type as idle on a fresh database", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_runtime_status_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });

      const status = await getConsoleRuntimeStatus({ databaseUrl: fixture.databaseUrl });

      // Rendered in the footer as "postgres <version>" — a real server report,
      // never a hardcoded string.
      expect(status.databaseServerVersion).toMatch(/^\d+(\.\d+)*$/);
      expect(status.workerJobs.map((entry) => entry.jobType)).toEqual([...consoleWorkerJobTypes]);
      expect(status.workerJobs.every((entry) => entry.activeCount === 0)).toBe(true);
      expect(status.busy).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it("counts pending and running jobs per type so the footer can say which worker is busy", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_runtime_busy_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
        await client.query(
          `insert into jobs (id, job_type, status, trigger, payload)
           values (gen_random_uuid(), 'model_refresh', 'pending', 'manual', '{}'::jsonb),
                  (gen_random_uuid(), 'model_refresh', 'running', 'scheduled', '{}'::jsonb),
                  (gen_random_uuid(), 'price_sync', 'succeeded', 'scheduled', '{}'::jsonb)`,
        );
      });

      const status = await getConsoleRuntimeStatus({ databaseUrl: fixture.databaseUrl });
      const byType = new Map(status.workerJobs.map((entry) => [entry.jobType, entry.activeCount]));

      expect(byType.get("model_refresh")).toBe(2);
      // Terminal jobs are history, not work in flight.
      expect(byType.get("price_sync")).toBe(0);
      expect(status.busy).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
