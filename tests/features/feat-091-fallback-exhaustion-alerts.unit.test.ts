import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFallbackExhaustionAlertsJobHandler,
  readFallbackExhaustionAlertPayload,
  readFallbackExhaustionAlertSettings,
} from "../../apps/worker/src/fallback-exhaustion-alerts";
import { createDefaultPeriodicTasks } from "../../apps/worker/src/periodic-scheduler";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-091 fallback exhaustion alerts", () => {
  it("declares a fallback_exhaustion_alerts job type migration", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0023" && candidate.name === "fallback_exhaustion_alerts",
    );

    expect(migration?.sql).toContain("'fallback_exhaustion_alerts'");
    expect(migration?.sql).toContain(
      "alter table jobs drop constraint if exists jobs_job_type_check",
    );
  });

  it("adds scheduler-created fallback exhaustion alert jobs with configurable window", () => {
    const task = createDefaultPeriodicTasks().find(
      (candidate) => candidate.jobType === "fallback_exhaustion_alerts",
    );

    expect(task).toMatchObject({
      id: "fallback-exhaustion-alerts",
      intervalMs: 5 * 60 * 1000,
      jobType: "fallback_exhaustion_alerts",
      maxAttempts: 1,
      payload: {
        windowMs: 15 * 60 * 1000,
      },
      priority: -5,
      startAt: new Date(0),
    });
  });

  it("reads fallback exhaustion alert settings from environment configuration", () => {
    expect(
      readFallbackExhaustionAlertSettings({
        FALLBACK_EXHAUSTION_ALERT_INTERVAL_MS: "60000",
        FALLBACK_EXHAUSTION_ALERT_WINDOW_MS: "300000",
      }),
    ).toEqual({
      intervalMs: 60_000,
      windowMs: 300_000,
    });
    expect(readFallbackExhaustionAlertSettings({})).toEqual({
      intervalMs: 5 * 60 * 1000,
      windowMs: 15 * 60 * 1000,
    });

    for (const env of [
      { FALLBACK_EXHAUSTION_ALERT_INTERVAL_MS: "0" },
      { FALLBACK_EXHAUSTION_ALERT_INTERVAL_MS: "soon" },
      { FALLBACK_EXHAUSTION_ALERT_WINDOW_MS: "0" },
      { FALLBACK_EXHAUSTION_ALERT_WINDOW_MS: "soon" },
    ]) {
      expect(() => readFallbackExhaustionAlertSettings(env)).toThrow("positive integer");
    }
  });

  it("lets the scheduled job payload override configured window", () => {
    expect(readFallbackExhaustionAlertPayload({ windowMs: 600_000 })).toEqual({
      windowMs: 600_000,
    });
    expect(readFallbackExhaustionAlertPayload({})).toEqual({
      windowMs: 15 * 60 * 1000,
    });

    for (const payload of [{ windowMs: 0 }, { windowMs: 1.5 }, { windowMs: "600000" }]) {
      expect(() => readFallbackExhaustionAlertPayload(payload)).toThrow();
    }
  });

  it("registers fallback_exhaustion_alerts in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createFallbackExhaustionAlertsJobHandler");
    expect(workerMain).toContain("fallback_exhaustion_alerts:");
    expect(
      createFallbackExhaustionAlertsJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
