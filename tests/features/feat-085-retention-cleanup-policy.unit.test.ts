import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultPeriodicTasks } from "../../apps/worker/src/periodic-scheduler";
import {
  createRetentionCleanupJobHandler,
  readRetentionCleanupPayload,
  readRetentionCleanupSettings,
} from "../../apps/worker/src/retention-cleanup";

const root = resolve(__dirname, "../..");

describe("feat-085 retention cleanup policy", () => {
  it("adds scheduler-created retention cleanup jobs with a configurable retention window", () => {
    const retentionTask = createDefaultPeriodicTasks().find(
      (task) => task.jobType === "retention_cleanup",
    );

    expect(retentionTask).toMatchObject({
      id: "retention-cleanup",
      intervalMs: 24 * 60 * 60 * 1000,
      jobType: "retention_cleanup",
      maxAttempts: 1,
      payload: {
        retentionDays: 30,
      },
      priority: 0,
      startAt: new Date(0),
    });
  });

  it("registers retention_cleanup in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createRetentionCleanupJobHandler");
    expect(workerMain).toContain("retention_cleanup:");
  });

  it("reads a positive integer retention window from the job payload", () => {
    const parsed = readRetentionCleanupPayload(
      { retentionDays: 14 },
      new Date("2026-06-16T00:00:00.000Z"),
    );

    expect(parsed).toEqual({
      cutoff: new Date("2026-06-02T00:00:00.000Z"),
      retentionDays: 14,
    });

    for (const payload of [
      {},
      { retentionDays: 0 },
      { retentionDays: -1 },
      { retentionDays: 1.5 },
      { retentionDays: "30" },
    ]) {
      expect(() =>
        readRetentionCleanupPayload(payload, new Date("2026-06-16T00:00:00.000Z")),
      ).toThrow("retentionDays must be a positive integer");
    }
  });

  it("reads retention cleanup settings from environment configuration", () => {
    expect(
      readRetentionCleanupSettings({
        RETENTION_CLEANUP_DAYS: "45",
        RETENTION_CLEANUP_INTERVAL_MS: "3600000",
      }),
    ).toEqual({
      intervalMs: 3_600_000,
      retentionDays: 45,
    });
    expect(readRetentionCleanupSettings({})).toEqual({
      intervalMs: 24 * 60 * 60 * 1000,
      retentionDays: 30,
    });

    for (const env of [
      { RETENTION_CLEANUP_DAYS: "0" },
      { RETENTION_CLEANUP_DAYS: "1.5" },
      { RETENTION_CLEANUP_INTERVAL_MS: "0" },
      { RETENTION_CLEANUP_INTERVAL_MS: "soon" },
    ]) {
      expect(() => readRetentionCleanupSettings(env)).toThrow("must be a positive integer");
    }
  });

  it("exposes a retention cleanup job handler factory", () => {
    expect(
      createRetentionCleanupJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
