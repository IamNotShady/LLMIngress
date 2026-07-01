import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultPeriodicTasks } from "@llmingress/db/worker-periodic-scheduler";
import {
  createProviderFailureAlertsJobHandler,
  readProviderFailureAlertPayload,
  readProviderFailureAlertSettings,
} from "@llmingress/db/worker-provider-failure-alerts";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-090 provider failure alerts", () => {
  it("declares a provider_failure_alerts job type migration", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0022" && candidate.name === "provider_failure_alerts",
    );

    expect(migration?.sql).toContain("'provider_failure_alerts'");
    expect(migration?.sql).toContain(
      "alter table jobs drop constraint if exists jobs_job_type_check",
    );
  });

  it("adds scheduler-created provider failure alert jobs with configurable threshold", () => {
    const task = createDefaultPeriodicTasks().find(
      (candidate) => candidate.jobType === "provider_failure_alerts",
    );

    expect(task).toMatchObject({
      id: "provider-failure-alerts",
      intervalMs: 5 * 60 * 1000,
      jobType: "provider_failure_alerts",
      maxAttempts: 1,
      payload: {
        thresholdCount: 3,
      },
      priority: -5,
      startAt: new Date(0),
    });
  });

  it("reads provider failure alert settings from environment configuration", () => {
    expect(
      readProviderFailureAlertSettings({
        PROVIDER_FAILURE_ALERT_INTERVAL_MS: "60000",
        PROVIDER_FAILURE_ALERT_THRESHOLD: "5",
      }),
    ).toEqual({
      intervalMs: 60_000,
      thresholdCount: 5,
    });
    expect(readProviderFailureAlertSettings({})).toEqual({
      intervalMs: 5 * 60 * 1000,
      thresholdCount: 3,
    });

    for (const env of [
      { PROVIDER_FAILURE_ALERT_INTERVAL_MS: "0" },
      { PROVIDER_FAILURE_ALERT_INTERVAL_MS: "soon" },
      { PROVIDER_FAILURE_ALERT_THRESHOLD: "0" },
      { PROVIDER_FAILURE_ALERT_THRESHOLD: "1.5" },
    ]) {
      expect(() => readProviderFailureAlertSettings(env)).toThrow("positive integer");
    }
  });

  it("lets the scheduled job payload override configured threshold", () => {
    expect(readProviderFailureAlertPayload({ thresholdCount: 7 })).toEqual({
      thresholdCount: 7,
    });
    expect(readProviderFailureAlertPayload({})).toEqual({
      thresholdCount: 3,
    });

    for (const payload of [
      { thresholdCount: 0 },
      { thresholdCount: 1.5 },
      { thresholdCount: "3" },
    ]) {
      expect(() => readProviderFailureAlertPayload(payload)).toThrow();
    }
  });

  it("registers provider_failure_alerts in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createProviderFailureAlertsJobHandler");
    expect(workerMain).toContain("provider_failure_alerts:");
    expect(
      createProviderFailureAlertsJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
