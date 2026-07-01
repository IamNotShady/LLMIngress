import { describe, expect, it } from "vitest";
import { normalizeConsoleActivityFilters } from "../../apps/console/src/server/activity";
import {
  buildGatewayResponseMetadata,
  type GatewayActivityCompletion,
} from "../../packages/db/src/gateway-activity-recorder";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-104 activity detail fallback metadata", () => {
  it("adds activity detail metadata fields to request_activity", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0028" && candidate.name === "activity_detail_metadata",
    );

    expect(migration?.sql).toContain("add column if not exists provider_api_key_id");
    expect(migration?.sql).toContain("add column if not exists provider_api_key_prefix");
    expect(migration?.sql).toContain("add column if not exists response_metadata");
    expect(migration?.sql).toContain("idx_request_activity_status_started_at");
    expect(migration?.sql).toContain("idx_request_activity_provider_started_at");
    expect(migration?.sql).toContain("idx_request_activity_agent_key_started_at");
    expect(migration?.sql).toContain("values (1, '0028')");
  });

  it("builds safe response metadata without prompt text response text or secrets", () => {
    const completion: GatewayActivityCompletion = {
      completedAt: new Date("2026-06-18T00:00:01.000Z"),
      errorCode: null,
      errorMessage: null,
      httpStatus: 200,
      latencyMs: 100,
      status: "succeeded",
    };

    const metadata = buildGatewayResponseMetadata({
      completion,
      responseBody: {
        id: "resp_104",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "never store generated text",
              role: "assistant",
            },
          },
        ],
        secret: "sk-response-secret",
        usage: {
          completion_tokens: 7,
          prompt_tokens: 11,
          total_tokens: 18,
        },
      },
    });

    expect(metadata).toEqual({
      finishReason: "stop",
      providerRequestId: "resp_104",
      status: "succeeded",
      tokenUsage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("never store generated text");
    expect(JSON.stringify(metadata)).not.toContain("sk-response-secret");
  });

  it("normalizes backend activity filters without frontend state", () => {
    expect(
      normalizeConsoleActivityFilters({
        agentApiKeyId: "agent-key-104",
        from: "2026-06-18T00:00:00.000Z",
        limit: 250,
        page: -1,
        protocol: "messages",
        providerId: "provider-104",
        providerModelId: "provider-model-104",
        requestId: " req_activity_104 ",
        status: "succeeded",
        to: "not-a-date",
      }),
    ).toEqual({
      agentApiKeyId: "agent-key-104",
      from: new Date("2026-06-18T00:00:00.000Z"),
      limit: 100,
      page: 1,
      protocol: "messages",
      providerId: "provider-104",
      providerModelId: "provider-model-104",
      requestId: "req_activity_104",
      status: "succeeded",
      to: undefined,
    });
  });
});
