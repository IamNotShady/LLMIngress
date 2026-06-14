export type LimitsFallbackFailureScenario = "budget" | "rpm" | "token" | "tpm";

export type LimitsFallbackRequestScenario =
  | LimitsFallbackFailureScenario
  | "fallback"
  | "rpm-prime";

export const limitsFallbackNames = {
  virtualModels: {
    budget: "limits-budget",
    fallback: "limits-fallback",
    rpm: "limits-rpm",
    token: "limits-token",
    tpm: "limits-tpm",
  },
} as const;

export function buildLimitsFallbackRequestId(scenario: LimitsFallbackRequestScenario): string {
  return `req_limits_${scenario.replace("-", "_")}_053`;
}

export function listLimitsFallbackExpectedFailures(): Array<{
  errorCode: "cost_budget_exceeded" | "rate_limit_exceeded" | "token_budget_exceeded";
  limitType?: "rpm" | "tpm";
  scenario: LimitsFallbackFailureScenario;
  status: 402 | 429;
}> {
  return [
    { errorCode: "rate_limit_exceeded", limitType: "rpm", scenario: "rpm", status: 429 },
    { errorCode: "rate_limit_exceeded", limitType: "tpm", scenario: "tpm", status: 429 },
    { errorCode: "token_budget_exceeded", scenario: "token", status: 402 },
    { errorCode: "cost_budget_exceeded", scenario: "budget", status: 402 },
  ];
}
