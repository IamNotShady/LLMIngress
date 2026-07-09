import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("console-section-data-split", () => {
  it("loads agents section data through the data module", () => {
    const data = readFileSync("apps/console/src/app/_modules/agents-section-data.ts", "utf8");
    expect(data).toContain("export async function loadAgentsSectionData");
    const section = readFileSync("apps/console/src/app/_modules/agents-section.tsx", "utf8");
    expect(section).toContain("loadAgentsSectionData(");
    expect(section).not.toContain("await getConsoleUsageSummary");
    expect(section).not.toContain("await listAgents()");
  });

  it("types playground response bodies as unknown", () => {
    const playground = readFileSync("apps/console/src/app/playground.tsx", "utf8");
    expect(playground).not.toContain("const body = await response.json()");
    expect(playground).not.toContain("const body = isStreamResponse");
    expect((playground.match(/const body: unknown =/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
