import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJsonlRequestLogRecord,
  redactSecretsFromJsonlValue,
} from "../../apps/worker/src/jsonl-export";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-081 JSONL request log export", () => {
  it("declares jsonl_export jobs and current job-result export tracking", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0016" && candidate.name === "jsonl_request_log_export",
    );
    const cleanupMigration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0039" && candidate.name === "merge_export_tasks_into_jobs",
    );

    expect(migration?.sql).toContain("'jsonl_export'");
    expect(migration?.sql).toContain("'jsonl_request_logs'");
    expect(cleanupMigration?.sql).toContain("drop table if exists export_tasks");
  });

  it("registers jsonl_export in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createJsonlRequestLogExportJobHandler");
    expect(workerMain).toContain("jsonl_export:");
  });

  it("formats request metadata fallback events and errors without secrets", () => {
    const record = buildJsonlRequestLogRecord({
      activity: {
        agent_key_prefix: "llmi_jsonl81",
        agent_id: "agent-081",
        agent_name: "JSONL Agent",
        agent_type: "coding",
        completed_at: new Date("2026-06-16T10:00:02.000Z"),
        created_at: new Date("2026-06-16T10:00:00.000Z"),
        error_code: "provider_request_failed",
        error_message: "provider failed with Bearer sk-jsonl-error-secret",
        fallback_attempts: [
          {
            authorization: "Bearer sk-jsonl-attempt-secret",
            errorCode: "provider_request_failed",
          },
        ],
        http_status: 502,
        id: "activity-081",
        latency_ms: 1200,
        model: "jsonl-fast",
        protocol: "chat_completions",
        provider_display_name: "JSONL Provider",
        provider_id: "provider-081",
        provider_key: "jsonl-provider",
        provider_model_display_name: "JSONL Model",
        provider_model_id: "provider-model-081",
        provider_model_model_id: "jsonl-real-model",
        request_id: "req_jsonl_unit_081",
        route_policy_id: "route-policy-081",
        route_reason: {
          apiKey: "sk-jsonl-route-secret",
          selected: "cost_first",
        },
        started_at: new Date("2026-06-16T10:00:00.000Z"),
        status: "failed",
        stream: false,
        virtual_model_id: "virtual-model-081",
        virtual_model_name: "jsonl-fast",
      },
      cost: {
        cost_source: "estimated",
        input_cost_usd: "0.00010000",
        output_cost_usd: "0.00020000",
        price_source: "built_in_static_snapshot",
        price_version: "unit-v1",
        total_cost_usd: "0.00030000",
      },
      fallbackEvents: [
        {
          attempt_order: 1,
          created_at: new Date("2026-06-16T10:00:01.000Z"),
          error_code: "provider_request_failed",
          error_message: "fallback failed with sk-jsonl-fallback-secret",
          failed_before_first_byte: true,
          provider_key: "jsonl-provider",
          provider_model_id: "provider-model-081",
          provider_model_model_id: "jsonl-real-model",
          status: "failed",
        },
      ],
      usage: {
        cached_input_tokens: 2,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 1,
        token_source: "provider",
        total_tokens: 15,
      },
    });

    expect(record).toMatchObject({
      agent: {
        id: "agent-081",
        keyPrefix: "llmi_jsonl81",
        name: "JSONL Agent",
        type: "coding",
      },
      cost: {
        totalCostUsd: 0.0003,
      },
      error: {
        code: "provider_request_failed",
        httpStatus: 502,
        message: "provider failed with Bearer [REDACTED]",
      },
      fallbackEvents: [
        expect.objectContaining({
          attemptOrder: 1,
          errorCode: "provider_request_failed",
          errorMessage: "fallback failed with [REDACTED]",
          failedBeforeFirstByte: true,
        }),
      ],
      requestId: "req_jsonl_unit_081",
      routeReason: {
        apiKey: "[REDACTED]",
        selected: "cost_first",
      },
      usage: {
        totalTokens: 15,
      },
    });

    const rawRecord = JSON.stringify(record);
    expect(rawRecord).not.toContain("sk-jsonl");
    expect(rawRecord).not.toContain("Bearer sk-");

    expect(
      redactSecretsFromJsonlValue({
        agentApiKeyPrefix: "llmi_keep_prefix",
        authorization: "Bearer sk-jsonl-header-secret",
        nested: { keyHash: "sha256:v1:jsonl-secret-hash" },
      }),
    ).toEqual({
      agentApiKeyPrefix: "llmi_keep_prefix",
      authorization: "[REDACTED]",
      nested: { keyHash: "[REDACTED]" },
    });
  });
});
