import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createBudgetThresholdAlertsJobHandler,
  readBudgetThresholdAlertPayload,
  readBudgetThresholdAlertSettings,
} from "@llmingress/db/worker-budget-threshold-alerts";
import { createDefaultPeriodicTasks } from "@llmingress/db/worker-periodic-scheduler";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-088 budget threshold alerts", () => {
  it("declares a budget_threshold_alerts job type migration", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0020" && candidate.name === "budget_threshold_alerts",
    );

    expect(migration?.sql).toContain("'budget_threshold_alerts'");
    expect(migration?.sql).toContain(
      "alter table jobs drop constraint if exists jobs_job_type_check",
    );
  });

  it("adds scheduler-created budget threshold alert jobs with configurable thresholds", () => {
    const task = createDefaultPeriodicTasks().find(
      (candidate) => candidate.jobType === "budget_threshold_alerts",
    );

    expect(task).toMatchObject({
      id: "budget-threshold-alerts",
      intervalMs: 15 * 60 * 1000,
      jobType: "budget_threshold_alerts",
      maxAttempts: 1,
      payload: {
        thresholdRatios: [0.8, 0.9],
      },
      priority: -5,
      startAt: new Date(0),
    });
  });

  it("reads budget alert threshold and interval settings from environment configuration", () => {
    expect(
      readBudgetThresholdAlertSettings({
        BUDGET_THRESHOLD_ALERT_INTERVAL_MS: "300000",
        BUDGET_WARNING_THRESHOLDS: "0.5,0.75, 0.9",
      }),
    ).toEqual({
      intervalMs: 300_000,
      thresholdRatios: [0.5, 0.75, 0.9],
    });
    expect(readBudgetThresholdAlertSettings({})).toEqual({
      intervalMs: 15 * 60 * 1000,
      thresholdRatios: [0.8, 0.9],
    });

    for (const env of [
      { BUDGET_THRESHOLD_ALERT_INTERVAL_MS: "0" },
      { BUDGET_THRESHOLD_ALERT_INTERVAL_MS: "soon" },
      { BUDGET_WARNING_THRESHOLDS: "" },
      { BUDGET_WARNING_THRESHOLDS: "0" },
      { BUDGET_WARNING_THRESHOLDS: "1.1" },
      { BUDGET_WARNING_THRESHOLDS: "0.9,0.9" },
      { BUDGET_WARNING_THRESHOLDS: "near" },
    ]) {
      expect(() => readBudgetThresholdAlertSettings(env)).toThrow();
    }
  });

  it("lets the scheduled job payload override configured thresholds", () => {
    expect(
      readBudgetThresholdAlertPayload({
        thresholdRatios: [0.6, 0.95],
      }),
    ).toEqual({
      thresholdRatios: [0.6, 0.95],
    });
    expect(readBudgetThresholdAlertPayload({})).toEqual({
      thresholdRatios: [0.8, 0.9],
    });

    for (const payload of [
      { thresholdRatios: [] },
      { thresholdRatios: [0] },
      { thresholdRatios: [1.5] },
      { thresholdRatios: ["0.8"] },
      { thresholdRatios: [0.8, 0.8] },
    ]) {
      expect(() => readBudgetThresholdAlertPayload(payload)).toThrow("thresholdRatios");
    }
  });

  it("registers budget_threshold_alerts in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createBudgetThresholdAlertsJobHandler");
    expect(workerMain).toContain("budget_threshold_alerts:");
    expect(
      createBudgetThresholdAlertsJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
