import { describe, expect, it } from "vitest";
import { deriveAgentStatus, normalizeAgentFormInput } from "../../apps/console/src/server/agents";
import { buildGatewayAgentRequestLog } from "../../apps/gateway/src/main";
import { applyGatewayRequestLoggingPolicy } from "../../packages/db/src/gateway-activity-recorder";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-103 agent platform status and request logging", () => {
  it("declares agent platform logging fields and request metadata schema in migration 0027", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0027" && candidate.name === "agent_platform_status_logging",
    );

    expect(migration?.sql).toContain("alter table agents");
    expect(migration?.sql).toContain("integration_platform text not null default 'other'");
    expect(migration?.sql).toContain("request_logging_enabled boolean not null default true");
    expect(migration?.sql).toContain("alter table request_activity");
    expect(migration?.sql).toContain("request_metadata jsonb not null default '{}'::jsonb");
    expect(migration?.sql).toContain("set version = '0027'");
  });

  it("normalizes agent type separately from integration platform and defaults request logging on", () => {
    expect(
      normalizeAgentFormInput({
        agentType: "terminal",
        integrationPlatform: "CLAUDE-CODE",
        name: "  Claude runner  ",
      }),
    ).toEqual({
      agentType: "terminal",
      integrationPlatform: "claude-code",
      name: "Claude runner",
      requestLoggingEnabled: true,
    });

    expect(
      normalizeAgentFormInput({
        agentType: "coding",
        integrationPlatform: "cursor",
        name: "Cursor",
        requestLoggingEnabled: "false",
      }),
    ).toMatchObject({
      agentType: "coding",
      integrationPlatform: "cursor",
      requestLoggingEnabled: false,
    });
    expect(() =>
      normalizeAgentFormInput({
        agentType: "coding",
        integrationPlatform: "unknown-platform",
        name: "Bad platform",
      }),
    ).toThrow(/integration platform/i);
  });

  it("derives offline online and high-risk status without heartbeat tables", () => {
    const now = new Date("2026-06-18T04:00:00.000Z");

    expect(deriveAgentStatus({ latestRequestAt: null, now })).toBe("offline");
    expect(
      deriveAgentStatus({
        latestRequestAt: new Date("2026-06-18T03:50:00.000Z"),
        now,
        recentFailureCount: 0,
        recentRequestCount: 4,
      }),
    ).toBe("online");
    expect(
      deriveAgentStatus({
        latestRequestAt: new Date("2026-06-18T03:59:00.000Z"),
        now,
        recentFailureCount: 3,
        recentRequestCount: 5,
      }),
    ).toBe("high-risk");
    expect(
      deriveAgentStatus({
        latestRequestAt: new Date("2026-06-18T03:59:00.000Z"),
        now,
        unhealthyReachableProviderCount: 1,
      }),
    ).toBe("high-risk");
    expect(
      deriveAgentStatus({
        latestRequestAt: new Date("2026-06-18T03:59:00.000Z"),
        limitUsageRatio: 1,
        now,
      }),
    ).toBe("high-risk");
  });

  it("strips request details while preserving accounting identifiers when logging is disabled", () => {
    const route = {
      fallbackAttempts: [{ errorCode: "provider_request_failed" }],
      modelId: "provider-model-name",
      providerId: "00000000-0000-4000-8000-000000000103",
      providerKey: "openai",
      providerModelId: "00000000-0000-4000-8000-000000001103",
      routePolicyId: "00000000-0000-4000-8000-000000002103",
      routeReason: { selectedBy: "fixed" },
    };

    expect(
      applyGatewayRequestLoggingPolicy({
        completion: {
          completedAt: new Date("2026-06-18T04:00:01.000Z"),
          errorCode: "provider_request_failed",
          errorMessage: "Provider exploded",
          httpStatus: 503,
          latencyMs: 1000,
          status: "failed",
        },
        requestLoggingEnabled: true,
        requestMetadata: { estimatedInputTokens: 5, model: "codex", protocol: "chat_completions" },
        route,
      }),
    ).toMatchObject({
      errorMessage: "Provider exploded",
      requestMetadata: { estimatedInputTokens: 5, model: "codex" },
      route,
    });

    expect(
      applyGatewayRequestLoggingPolicy({
        completion: {
          completedAt: new Date("2026-06-18T04:00:01.000Z"),
          errorCode: "provider_request_failed",
          errorMessage: "Provider exploded",
          httpStatus: 503,
          latencyMs: 1000,
          status: "failed",
        },
        requestLoggingEnabled: false,
        requestMetadata: { estimatedInputTokens: 5, model: "codex", protocol: "chat_completions" },
        route,
      }),
    ).toMatchObject({
      errorMessage: null,
      requestMetadata: {},
      route: {
        fallbackAttempts: [],
        modelId: "provider-model-name",
        providerId: "00000000-0000-4000-8000-000000000103",
        providerKey: "openai",
        providerModelId: "00000000-0000-4000-8000-000000001103",
        routePolicyId: "00000000-0000-4000-8000-000000002103",
        routeReason: {},
      },
    });
  });

  it("builds detailed gateway agent request logs only when request logging is enabled", () => {
    const input = {
      agentId: "agent-103",
      agentKeyPrefix: "llmi103",
      method: "POST",
      protocol: "responses" as const,
      requestBody: {
        input: "debug this request",
        model: "gpt55",
        stream: true,
      },
      requestId: "req_agent_log_103",
      requestLoggingEnabled: true,
      url: "/v1/responses",
      virtualModelName: "gpt55",
    };

    expect(buildGatewayAgentRequestLog(input)).toEqual({
      agentId: "agent-103",
      agentKeyPrefix: "llmi103",
      method: "POST",
      protocol: "responses",
      requestBody: {
        input: "debug this request",
        model: "gpt55",
        stream: true,
      },
      requestId: "req_agent_log_103",
      url: "/v1/responses",
      virtualModel: "gpt55",
    });
    expect(
      buildGatewayAgentRequestLog({
        ...input,
        requestLoggingEnabled: false,
      }),
    ).toBeNull();
  });
});
