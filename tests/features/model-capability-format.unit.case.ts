import { describe, expect, it } from "vitest";
import { formatModelContextTokens } from "../../apps/console/src/app/_ui/model-capability-format.ts";

describe("model capability formatting", () => {
  it("renders known context windows as exact grouped token counts", () => {
    expect(formatModelContextTokens(1_000_000)).toBe("1,000,000");
    expect(formatModelContextTokens(1_048_576)).toBe("1,048,576");
    expect(formatModelContextTokens(128_000)).toBe("128,000");
  });

  it("keeps near-identical context windows visually distinct", () => {
    // The reported bug: 1M and ~1M both rounded to the same "~1M" abbreviation.
    expect(formatModelContextTokens(1_000_000)).not.toBe(formatModelContextTokens(1_048_576));
  });

  it("renders an unknown context window as Unknown", () => {
    expect(formatModelContextTokens(null)).toBe("Unknown");
  });
});
