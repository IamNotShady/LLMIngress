import { summarizeExpiredBudgetReservationRelease } from "@llmingress/db/worker-stale-reservations";
import { describe, expect, it } from "vitest";

describe("feat-043 stale reservation cleanup", () => {
  it("summarizes released expired budget reservations for the job result", () => {
    expect(
      summarizeExpiredBudgetReservationRelease([
        {
          reservedCostUsd: 0.12,
          reservedInputTokens: 100,
          reservedOutputTokens: 50,
        },
        {
          reservedCostUsd: 0.08,
          reservedInputTokens: 40,
          reservedOutputTokens: 60,
        },
      ]),
    ).toEqual({
      releasedReservationCount: 2,
      releasedReservedCostUsd: 0.2,
      releasedReservedTokens: 250,
    });
  });

  it("returns zero counts when no expired reservations are released", () => {
    expect(summarizeExpiredBudgetReservationRelease([])).toEqual({
      releasedReservationCount: 0,
      releasedReservedCostUsd: 0,
      releasedReservedTokens: 0,
    });
  });
});
