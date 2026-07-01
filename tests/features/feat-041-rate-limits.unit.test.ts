import { describe, expect, it } from "vitest";
import {
  createGatewayRateLimitErrorBody,
  evaluateGatewayRateLimitWindow,
  getMinuteWindow,
} from "../../packages/db/src/gateway-rate-limits";

describe("feat-041 RPM and TPM enforcement", () => {
  it("calculates stable minute windows for rate limit counters", () => {
    expect(getMinuteWindow(new Date("2026-06-14T07:08:09.123Z"))).toEqual({
      windowEnd: new Date("2026-06-14T07:09:00.000Z"),
      windowStart: new Date("2026-06-14T07:08:00.000Z"),
    });
  });

  it("allows counts at the limit and rejects increments that exceed the limit", () => {
    expect(
      evaluateGatewayRateLimitWindow({
        currentCount: 59,
        increment: 1,
        limitType: "rpm",
        limitValue: 60,
        requestId: "req_rate_unit",
        retryAfterMs: 12_000,
      }),
    ).toEqual({ ok: true });

    expect(
      evaluateGatewayRateLimitWindow({
        currentCount: 60,
        increment: 1,
        limitType: "rpm",
        limitValue: 60,
        requestId: "req_rate_unit",
        retryAfterMs: 12_000,
      }),
    ).toEqual({
      body: createGatewayRateLimitErrorBody({
        limitType: "rpm",
        requestId: "req_rate_unit",
        retryAfterMs: 12_000,
      }),
      ok: false,
      retryAfterSeconds: 12,
      statusCode: 429,
    });
  });

  it("returns a stable 429 error body with retry-after metadata", () => {
    expect(
      createGatewayRateLimitErrorBody({
        limitType: "tpm",
        requestId: "req_tpm_unit",
        retryAfterMs: 1_500,
      }),
    ).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "Agent API key exceeded its TPM limit.",
      },
      limitType: "tpm",
      requestId: "req_tpm_unit",
      retryAfterMs: 1_500,
      retryAfterSeconds: 2,
    });
  });
});
