import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readBackupJobPayload, readBackupSettings } from "@llmingress/db/worker-backup";
import { createDefaultPeriodicTasks } from "@llmingress/db/worker-periodic-scheduler";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("feat-086 backup job", () => {
  it("adds a pre-migration backup CLI script", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

    expect(packageJson.scripts["db:backup"]).toBe(
      "tsx scripts/run-with-env.ts tsx scripts/backup.ts",
    );
    expect(existsSync(resolve(root, "scripts/backup.ts"))).toBe(true);
  });

  it("adds scheduler-created backup jobs with configurable output settings", () => {
    const backupTask = createDefaultPeriodicTasks().find((task) => task.jobType === "backup");

    expect(backupTask).toMatchObject({
      id: "backup",
      intervalMs: 24 * 60 * 60 * 1000,
      jobType: "backup",
      maxAttempts: 1,
      payload: {
        outputDir: ".llmingress/backups",
      },
      priority: -10,
      startAt: new Date(0),
    });
  });

  it("registers backup in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createBackupJobHandler");
    expect(workerMain).toContain("backup:");
  });

  it("reads backup settings and backup job payloads", () => {
    expect(
      readBackupSettings({
        BACKUP_INTERVAL_MS: "3600000",
        BACKUP_OUTPUT_DIR: "/tmp/llmingress-backups",
      }),
    ).toEqual({
      intervalMs: 3_600_000,
      outputDir: "/tmp/llmingress-backups",
    });
    expect(readBackupSettings({})).toEqual({
      intervalMs: 24 * 60 * 60 * 1000,
      outputDir: ".llmingress/backups",
    });

    expect(
      readBackupJobPayload(
        {
          outputDir: "/tmp/llmingress-backups",
          schedule: {
            windowStart: "2026-06-16T00:00:00.000Z",
          },
        },
        new Date("2026-06-16T12:34:56.000Z"),
        "scheduled",
      ),
    ).toEqual({
      mode: "scheduled",
      outputPath:
        "/tmp/llmingress-backups/llmingress-backup-scheduled-2026-06-16T00-00-00-000Z.json",
    });
    expect(
      readBackupJobPayload(
        { outputPath: "/tmp/manual-backup.json" },
        new Date("2026-06-16T12:34:56.000Z"),
        "manual",
      ),
    ).toEqual({
      mode: "manual",
      outputPath: "/tmp/manual-backup.json",
    });

    for (const env of [
      { BACKUP_INTERVAL_MS: "0" },
      { BACKUP_INTERVAL_MS: "soon" },
      { BACKUP_OUTPUT_DIR: "" },
    ]) {
      expect(() => readBackupSettings(env)).toThrow();
    }
  });
});
