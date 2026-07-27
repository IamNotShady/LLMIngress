import { describe, expect, it } from "vitest";
import { formatModelContextTokens } from "../../apps/console/src/app/_ui/model-capability-format.ts";

describe("model capability formatting", () => {
  it("renders context windows the compact way the tables are laid out for", () => {
    expect(formatModelContextTokens(200_000)).toBe("200k");
    expect(formatModelContextTokens(400_000)).toBe("400k");
    expect(formatModelContextTokens(128_000)).toBe("128k");
    expect(formatModelContextTokens(1_000_000)).toBe("1M");
    expect(formatModelContextTokens(32_768)).toBe("32.8k");
    expect(formatModelContextTokens(512)).toBe("512");
  });

  it("keeps near-identical context windows visually distinct", () => {
    // The reported bug: 1M and ~1M both rounded to the same abbreviation, so
    // two candidates that fail the capability contract for differing on this
    // very number read as agreeing on it.
    expect(formatModelContextTokens(1_048_576)).toBe("1.05M");
    expect(formatModelContextTokens(1_000_000)).not.toBe(formatModelContextTokens(1_048_576));
    expect(formatModelContextTokens(200_000)).not.toBe(formatModelContextTokens(204_800));
  });

  it("renders an unknown context window as Unknown", () => {
    expect(formatModelContextTokens(null)).toBe("Unknown");
  });
});
