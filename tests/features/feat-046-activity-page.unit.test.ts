import {
  formatConsoleActivityCost,
  formatConsoleActivityFallbackAttempts,
  formatConsoleActivityRouteReason,
  formatConsoleActivityTokens,
} from "@llmingress/db/console-activity";
import { describe, expect, it } from "vitest";

describe("feat-046 activity console page", () => {
  it("formats token and cost labels for activity details", () => {
    expect(
      formatConsoleActivityTokens({
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46,
      }),
    ).toBe("46 total tokens (12 input, 34 output)");

    expect(formatConsoleActivityCost("0.00004050")).toBe("$0.00004050");
    expect(formatConsoleActivityCost(null)).toBe("Unavailable");
  });

  it("formats route reason and fallback attempts from recorded JSON", () => {
    expect(
      formatConsoleActivityRouteReason({
        message: "cost_first route selected cheapest eligible candidate 2.",
        selectedCandidateOrder: 2,
        strategy: "cost_first",
      }),
    ).toBe("cost_first route selected cheapest eligible candidate 2.");

    expect(
      formatConsoleActivityFallbackAttempts([
        {
          attemptOrder: 1,
          errorCode: "provider_request_failed",
          errorMessage: "network failed before first byte",
          failedBeforeFirstByte: true,
          providerModelId: "provider-model-1",
        },
      ]),
    ).toEqual(["Attempt 1: provider_request_failed before first byte on provider-model-1"]);
  });

  it("uses explicit empty labels when activity metadata was not recorded", () => {
    expect(formatConsoleActivityRouteReason({})).toBe("No route reason recorded");
    expect(formatConsoleActivityFallbackAttempts([])).toEqual(["No fallback attempts"]);
  });
});
