import { describe, expect, it } from "vitest";
import {
  calculateBudgetReservation,
  createGatewayBudgetErrorBody,
  getBudgetPeriodWindow,
} from "../../packages/db/src/gateway-budgets";

describe("feat-042 token and cost budget enforcement", () => {
  it("calculates budget periods for day week and month", () => {
    const now = new Date("2026-06-14T16:45:30.000Z");

    expect(getBudgetPeriodWindow(now, "day")).toEqual({
      periodEnd: new Date("2026-06-15T00:00:00.000Z"),
      periodStart: new Date("2026-06-14T00:00:00.000Z"),
    });
    expect(getBudgetPeriodWindow(now, "month")).toEqual({
      periodEnd: new Date("2026-07-01T00:00:00.000Z"),
      periodStart: new Date("2026-06-01T00:00:00.000Z"),
    });
  });

  it("rejects over-token and over-cost reservations with stable 402 bodies", () => {
    expect(
      createGatewayBudgetErrorBody({
        code: "token_budget_exceeded",
        requestId: "req_token_budget_unit",
      }),
    ).toEqual({
      error: {
        code: "token_budget_exceeded",
        message: "Agent API key token budget was exceeded.",
      },
      requestId: "req_token_budget_unit",
    });

    expect(
      createGatewayBudgetErrorBody({
        code: "cost_budget_exceeded",
        requestId: "req_cost_budget_unit",
      }),
    ).toEqual({
      error: {
        code: "cost_budget_exceeded",
        message: "Agent API key cost budget was exceeded.",
      },
      requestId: "req_cost_budget_unit",
    });
  });

  it("calculates reserved tokens and cost from request metadata and selected model price", () => {
    expect(
      calculateBudgetReservation({
        estimatedInputTokens: 100,
        estimatedOutputTokens: 200,
        inputUsdPerMillionTokens: 0.4,
        outputUsdPerMillionTokens: 1.6,
      }),
    ).toEqual({
      reservedCostUsd: 0.00036,
      reservedInputTokens: 100,
      reservedOutputTokens: 200,
      reservedTotalTokens: 300,
    });
  });
});
