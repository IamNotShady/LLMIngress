import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("feat-061 console interaction layout", () => {
  it("keeps Playground labels and controls in paired field containers", () => {
    const source = readFileSync("apps/console/src/app/playground.tsx", "utf8");

    for (const id of [
      "playground-agent-api-key",
      "playground-endpoint",
      "playground-model",
      "playground-prompt",
      "playground-system-prompt",
      "playground-temperature",
      "playground-top-p",
      "playground-max-tokens",
      "playground-stream",
    ]) {
      expect(source).toMatch(
        new RegExp(
          `<div className="console-field[^"]*">[\\s\\S]*?htmlFor="${id}"[\\s\\S]*?id="${id}"[\\s\\S]*?</div>`,
        ),
      );
    }

    expect(source).toMatch(/className="[^"]*console-actions[^"]*"/);
  });
});
