import { join } from "node:path";
import type { OpenTelemetrySpanInput } from "../../packages/observability/src/traces";

export type V1DailyOperationsCoverage =
  | "backup"
  | "budget_threshold_alert"
  | "cost_report_export"
  | "fallback_exhaustion_alert"
  | "jsonl_request_log_export"
  | "migration_status"
  | "notification_dispatch"
  | "opentelemetry_traces"
  | "prometheus_metrics"
  | "provider_failure_alert"
  | "rate_limit_alert"
  | "retention_cleanup"
  | "usage_breakdowns"
  | "webhook_event_export";

export type V1DailyOperationsSmokePlan = {
  alerts: {
    budgetThreshold: {
      thresholdRatios: number[];
    };
    fallbackExhaustion: {
      windowMs: number;
    };
    providerFailure: {
      thresholdCount: number;
    };
    rateLimit: {
      thresholdCount: number;
      windowMs: number;
    };
  };
  coverage: V1DailyOperationsCoverage[];
  now: Date;
  paths: {
    backup: string;
    costReport: string;
    jsonlExport: string;
    oldExport: string;
  };
  retention: {
    retentionDays: number;
  };
  traceSpans: OpenTelemetrySpanInput[];
  webhookUrl: string;
};

export function buildV1DailyOperationsSmokePlan(input: {
  outputDir: string;
  webhookUrl: string;
}): V1DailyOperationsSmokePlan {
  const now = new Date(Date.now() - 60_000);

  return {
    alerts: {
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
    },
    coverage: [
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
    ],
    now,
    paths: {
      backup: join(input.outputDir, "daily-operations-backup.json"),
      costReport: join(input.outputDir, "daily-operations-cost-report.json"),
      jsonlExport: join(input.outputDir, "daily-operations-requests.jsonl"),
      oldExport: join(input.outputDir, "expired-request-log.jsonl"),
    },
    retention: {
      retentionDays: 30,
    },
    traceSpans: [
      {
        attributes: {
          "llmingress.model": "gpt-4.1-mini",
          "llmingress.provider": "openai",
          "llmingress.status": "succeeded",
          "prompt.content": "secret prompt sk-secret-095",
          "request.id": "req_daily_success_095",
        },
        endTimeUnixNano: "2000000",
        kind: "server",
        name: "llmingress.gateway.request",
        spanId: "2222222222222222",
        startTimeUnixNano: "1000000",
        traceId: "11111111111111111111111111111111",
      },
      {
        attributes: {
          "job.id": "job_daily_backup_095",
          "job.type": "backup",
          "llmingress.status": "succeeded",
          "secret.key": "sk-secret-095",
        },
        endTimeUnixNano: "4000000",
        kind: "internal",
        name: "llmingress.worker.job",
        spanId: "4444444444444444",
        startTimeUnixNano: "3000000",
        traceId: "33333333333333333333333333333333",
      },
    ],
    webhookUrl: input.webhookUrl,
  };
}
