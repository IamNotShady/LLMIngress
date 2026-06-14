import { describe, expect, it } from "vitest";
import {
  formatConsoleUsageCost,
  formatConsoleUsageTokens,
  parseConsoleUsageWindow,
} from "../../apps/console/src/server/usage";

describe("feat-047 usage and cost console page", () => {
  it("normalizes selected usage windows", () => {
    expect(parseConsoleUsageWindow("24h")).toBe("24h");
    expect(parseConsoleUsageWindow("7d")).toBe("7d");
    expect(parseConsoleUsageWindow("30d")).toBe("30d");
    expect(parseConsoleUsageWindow("bad-window")).toBe("24h");
    expect(parseConsoleUsageWindow(undefined)).toBe("24h");
  });

  it("formats token and cost summary labels", () => {
    expect(
      formatConsoleUsageTokens({
        inputTokens: 150,
        outputTokens: 300,
        totalTokens: 450,
      }),
    ).toBe("450 total tokens (150 input, 300 output)");

    expect(formatConsoleUsageCost("0.00150000")).toBe("$0.00150000");
    expect(formatConsoleUsageCost(null)).toBe("$0.00000000");
  });
});
