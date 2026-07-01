import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultPeriodicTasks } from "@llmingress/db/worker-periodic-scheduler";
import {
  createRateLimitAlertsJobHandler,
  readRateLimitAlertPayload,
  readRateLimitAlertSettings,
} from "@llmingress/db/worker-rate-limit-alerts";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-089 rate limit high-frequency alerts", () => {
  it("declares a rate_limit_alerts job type migration", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0021" && candidate.name === "rate_limit_alerts",
    );

    expect(migration?.sql).toContain("'rate_limit_alerts'");
    expect(migration?.sql).toContain(
      "alter table jobs drop constraint if exists jobs_job_type_check",
    );
  });

  it("adds scheduler-created rate limit alert jobs with configurable window and threshold", () => {
    const task = createDefaultPeriodicTasks().find(
      (candidate) => candidate.jobType === "rate_limit_alerts",
    );

    expect(task).toMatchObject({
      id: "rate-limit-alerts",
      intervalMs: 5 * 60 * 1000,
      jobType: "rate_limit_alerts",
      maxAttempts: 1,
      payload: {
        thresholdCount: 3,
        windowMs: 15 * 60 * 1000,
      },
      priority: -5,
      startAt: new Date(0),
    });
  });

  it("reads rate limit alert settings from environment configuration", () => {
    expect(
      readRateLimitAlertSettings({
        RATE_LIMIT_ALERT_INTERVAL_MS: "60000",
        RATE_LIMIT_ALERT_THRESHOLD: "5",
        RATE_LIMIT_ALERT_WINDOW_MS: "300000",
      }),
    ).toEqual({
      intervalMs: 60_000,
      thresholdCount: 5,
      windowMs: 300_000,
    });
    expect(readRateLimitAlertSettings({})).toEqual({
      intervalMs: 5 * 60 * 1000,
      thresholdCount: 3,
      windowMs: 15 * 60 * 1000,
    });

    for (const env of [
      { RATE_LIMIT_ALERT_INTERVAL_MS: "0" },
      { RATE_LIMIT_ALERT_INTERVAL_MS: "soon" },
      { RATE_LIMIT_ALERT_THRESHOLD: "0" },
      { RATE_LIMIT_ALERT_THRESHOLD: "1.5" },
      { RATE_LIMIT_ALERT_WINDOW_MS: "0" },
      { RATE_LIMIT_ALERT_WINDOW_MS: "soon" },
    ]) {
      expect(() => readRateLimitAlertSettings(env)).toThrow("positive integer");
    }
  });

  it("lets the scheduled job payload override configured window and threshold", () => {
    expect(
      readRateLimitAlertPayload({
        thresholdCount: 7,
        windowMs: 600_000,
      }),
    ).toEqual({
      thresholdCount: 7,
      windowMs: 600_000,
    });
    expect(readRateLimitAlertPayload({})).toEqual({
      thresholdCount: 3,
      windowMs: 15 * 60 * 1000,
    });

    for (const payload of [
      { thresholdCount: 0, windowMs: 600_000 },
      { thresholdCount: 1.5, windowMs: 600_000 },
      { thresholdCount: "3", windowMs: 600_000 },
      { thresholdCount: 3, windowMs: 0 },
      { thresholdCount: 3, windowMs: "600000" },
    ]) {
      expect(() => readRateLimitAlertPayload(payload)).toThrow();
    }
  });

  it("registers rate_limit_alerts in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createRateLimitAlertsJobHandler");
    expect(workerMain).toContain("rate_limit_alerts:");
    expect(
      createRateLimitAlertsJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
