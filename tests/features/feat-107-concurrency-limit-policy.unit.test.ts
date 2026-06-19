import { describe, expect, it } from "vitest";
import { normalizeAgentLimitFormInput } from "../../apps/console/src/server/agent-limits";
import {
  createGatewayRateLimitErrorBody,
  evaluateGatewayRateLimitWindow,
  getConcurrencyWindow,
} from "../../apps/gateway/src/rate-limits";

describe("feat-107 concurrency limits and enforcement policy", () => {
  it("uses one fixed window for in-flight concurrency", () => {
    expect(getConcurrencyWindow()).toEqual({
      windowEnd: new Date("9999-12-31T23:59:59.999Z"),
      windowStart: new Date("1970-01-01T00:00:00.000Z"),
    });
  });

  it("blocks concurrency over limit with the stable rate limit body", () => {
    expect(
      evaluateGatewayRateLimitWindow({
        currentCount: 1,
        enforcementPolicy: "block",
        increment: 1,
        limitType: "concurrency",
        limitValue: 1,
        manualBypass: false,
        requestId: "req_concurrency_unit",
        retryAfterMs: 1,
      }),
    ).toEqual({
      body: createGatewayRateLimitErrorBody({
        limitType: "concurrency",
        requestId: "req_concurrency_unit",
        retryAfterMs: 1,
      }),
      ok: false,
      retryAfterSeconds: 1,
      statusCode: 429,
    });
  });

  it("allows over-limit requests for warn_only or manual bypass policies", () => {
    expect(
      evaluateGatewayRateLimitWindow({
        currentCount: 1,
        enforcementPolicy: "warn_only",
        increment: 1,
        limitType: "concurrency",
        limitValue: 1,
        manualBypass: false,
        requestId: "req_concurrency_warn",
        retryAfterMs: 1,
      }),
    ).toEqual({ ok: true });

    expect(
      evaluateGatewayRateLimitWindow({
        currentCount: 1,
        enforcementPolicy: "block",
        increment: 1,
        limitType: "rpm",
        limitValue: 1,
        manualBypass: true,
        requestId: "req_rpm_bypass",
        retryAfterMs: 1,
      }),
    ).toEqual({ ok: true });
  });

  it("defaults new policy fields for existing Console limit form input", () => {
    const normalized = normalizeAgentLimitFormInput({
      agentId: "00000000-0000-4000-8000-000000000107",
      budgetPeriod: "month",
      budgetUsd: 10,
      rpm: 60,
      tokenLimit: 200_000,
      tpm: 1_000_000,
    });

    expect(normalized.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alertThreshold: null,
          enforcementPolicy: "block",
          limitType: "rpm",
          manualBypass: false,
        }),
        expect.objectContaining({
          alertThreshold: null,
          enforcementPolicy: "block",
          limitType: "tpm",
          manualBypass: false,
        }),
      ]),
    );
  });
});
