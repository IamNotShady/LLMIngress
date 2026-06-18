import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWebhookEventExportRecords,
  createWebhookEventExportJobHandler,
  redactWebhookExportValue,
} from "../../apps/worker/src/webhook-export";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-084 webhook event export", () => {
  it("declares webhook delivery audit storage without using notification event tables", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0019" && candidate.name === "webhook_event_export",
    );
    const allSql = loadSqlMigrations()
      .map((candidate) => candidate.sql)
      .join("\n");

    expect(migration?.sql).toContain("create table if not exists webhook_deliveries");
    expect(migration?.sql).toContain("event_type text not null check");
    expect(migration?.sql).toContain("'request'");
    expect(migration?.sql).toContain("'fallback'");
    expect(migration?.sql).toContain("'error'");
    expect(migration?.sql).not.toContain("notification_events");
    expect(allSql).toContain("'webhook_export'");
  });

  it("registers webhook_export in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createWebhookEventExportJobHandler");
    expect(workerMain).toContain("webhook_export:");
  });

  it("builds request fallback and error webhook events with secret redaction", () => {
    const records = buildWebhookEventExportRecords({
      activity: {
        agentApiKeyPrefix: "llmi_webhook84",
        completedAt: new Date("2026-01-01T00:00:02.000Z"),
        errorCode: "provider_request_failed",
        errorMessage: "provider failed with Bearer sk-webhook-error-secret",
        httpStatus: 502,
        id: "activity-084",
        latencyMs: 2000,
        model: "webhook-fast",
        protocol: "chat_completions",
        providerKey: "openai",
        providerModelModelId: "gpt-4.1-mini",
        requestId: "req_webhook_unit_084",
        routeReason: {
          authorization: "Bearer sk-webhook-route-secret",
          selected: "fallback",
        },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: "failed",
        stream: false,
        virtualModelName: "webhook-fast",
      },
      fallbackEvents: [
        {
          attemptOrder: 1,
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          errorCode: "provider_request_failed",
          errorMessage: "fallback failed with sk-webhook-fallback-secret",
          failedBeforeFirstByte: true,
          id: "fallback-084",
          providerKey: "openai",
          providerModelModelId: "gpt-4.1-mini",
          status: "failed",
        },
      ],
    });

    expect(records.map((record) => record.eventType)).toEqual(["request", "fallback", "error"]);
    expect(records[0]).toMatchObject({
      eventType: "request",
      requestId: "req_webhook_unit_084",
      request: {
        model: "webhook-fast",
        routeReason: {
          authorization: "[REDACTED]",
          selected: "fallback",
        },
        status: "failed",
      },
    });
    expect(records[1]).toMatchObject({
      eventType: "fallback",
      fallback: {
        attemptOrder: 1,
        errorMessage: "fallback failed with [REDACTED]",
        failedBeforeFirstByte: true,
      },
    });
    expect(records[2]).toMatchObject({
      error: {
        code: "provider_request_failed",
        message: "provider failed with Bearer [REDACTED]",
      },
      eventType: "error",
    });
    expect(JSON.stringify(records)).not.toContain("sk-webhook");
  });

  it("redacts webhook export values using the request log redaction rules", () => {
    expect(
      redactWebhookExportValue({
        apiKey: "sk-webhook-api-secret",
        keepPrefix: "llmi_keep84",
        nested: {
          authorization: "Bearer sk-webhook-bearer-secret",
          providerKey: "openai",
        },
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      keepPrefix: "llmi_keep84",
      nested: {
        authorization: "[REDACTED]",
        providerKey: "openai",
      },
    });
  });

  it("exposes a webhook event export job handler factory", () => {
    expect(
      createWebhookEventExportJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
