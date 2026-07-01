import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("feat-077 agent connection details", () => {
  it("keeps one normalized connection details group inside the Agent route", () => {
    const route = readFileSync(
      join(process.cwd(), "apps/console/src/app/api/agents/route.ts"),
      "utf8",
    );

    expect(route).toContain("function buildAgentConnectionDetails");
    expect(route).toContain("normalizeGatewayBaseUrl");
    expect(route).toContain("normalizeSnippetField");
    expect(route).toContain('.replace(/\\/+$/, "")');
    expect(route).toContain("Agent connection details");
  });
});
