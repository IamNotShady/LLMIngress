import { defaultAgentLimitFormValues } from "@llmingress/db/console-agent-limits";
import { describe, expect, it } from "vitest";
import {
  buildLimitsFallbackRequestId,
  limitsFallbackNames,
  listLimitsFallbackExpectedFailures,
} from "../support/limits-fallback";

describe("feat-053 limits and fallback scenario support", () => {
  it("keeps the E2E limit failures and fallback request ids stable", () => {
    expect(limitsFallbackNames.virtualModels).toEqual({
      budget: "limits-budget",
      fallback: "limits-fallback",
      rpm: "limits-rpm",
      token: "limits-token",
      tpm: "limits-tpm",
    });
    expect(listLimitsFallbackExpectedFailures()).toEqual([
      { errorCode: "rate_limit_exceeded", limitType: "rpm", scenario: "rpm", status: 429 },
      { errorCode: "rate_limit_exceeded", limitType: "tpm", scenario: "tpm", status: 429 },
      { errorCode: "token_budget_exceeded", scenario: "token", status: 402 },
      { errorCode: "cost_budget_exceeded", scenario: "budget", status: 402 },
    ]);

    const requestIds = [
      buildLimitsFallbackRequestId("rpm-prime"),
      buildLimitsFallbackRequestId("rpm"),
      buildLimitsFallbackRequestId("tpm"),
      buildLimitsFallbackRequestId("token"),
      buildLimitsFallbackRequestId("budget"),
      buildLimitsFallbackRequestId("fallback"),
    ];

    expect(requestIds).toEqual([
      "req_limits_rpm_prime_053",
      "req_limits_rpm_053",
      "req_limits_tpm_053",
      "req_limits_token_053",
      "req_limits_budget_053",
      "req_limits_fallback_053",
    ]);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  it("uses Agent-ready default limit values for tool-heavy clients", () => {
    expect(defaultAgentLimitFormValues.tokenLimit).toBeGreaterThanOrEqual(200_000);
    expect(defaultAgentLimitFormValues.tpm).toBeGreaterThanOrEqual(
      defaultAgentLimitFormValues.tokenLimit,
    );
    expect(defaultAgentLimitFormValues.rpm).toBeGreaterThanOrEqual(60);
  });
});
