import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildV1DailyOperationsSmokePlan } from "../support/v1-daily-operations-smoke";

describe("v1 worker operations milestone", () => {
  it("plans the full daily operations coverage surface", () => {
    const plan = buildV1DailyOperationsSmokePlan({
      outputDir: "/tmp/llmingress-daily-ops",
      webhookUrl: "http://127.0.0.1:9999/webhook",
    });

    expect(plan.coverage).toEqual([
      "usage_breakdowns",
      "jsonl_request_log_export",
      "cost_report_export",
      "webhook_event_export",
      "budget_threshold_alert",
      "rate_limit_alert",
      "provider_failure_alert",
      "fallback_exhaustion_alert",
      "notification_dispatch",
      "prometheus_metrics",
      "opentelemetry_traces",
      "backup",
      "migration_status",
      "retention_cleanup",
    ]);
    expect(plan.alerts).toEqual({
      budgetThreshold: {
        thresholdRatios: [0.8],
      },
      fallbackExhaustion: {
        windowMs: 15 * 60 * 1000,
      },
      providerFailure: {
        thresholdCount: 2,
      },
      rateLimit: {
        thresholdCount: 3,
        windowMs: 15 * 60 * 1000,
      },
    });
    expect(plan.retention).toEqual({
      retentionDays: 30,
    });
    expect(plan.paths).toEqual({
      backup: "/tmp/llmingress-daily-ops/daily-operations-backup.json",
      costReport: "/tmp/llmingress-daily-ops/daily-operations-cost-report.json",
      jsonlExport: "/tmp/llmingress-daily-ops/daily-operations-requests.jsonl",
      oldExport: "/tmp/llmingress-daily-ops/expired-request-log.jsonl",
    });
  });

  it("claims due jobs with the runner clock instead of the database wall clock", () => {
    const source = readFileSync("packages/worker-runtime/src/worker-job-runner.ts", "utf8");

    expect(source).toContain("and run_after <= $4::timestamptz");
    expect(source).toContain(
      "lease_expires_at = $4::timestamptz + ($2::integer * interval '1 millisecond')",
    );
    expect(source).toContain("values ($1, $2, $3, $4, 'running', $5::timestamptz)");
    expect(source).not.toContain("and run_after <= now()");
  });
});
