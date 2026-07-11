import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modulesDir = "apps/console/src/app/_modules";
const sectionFiles = [
  "overview-section.tsx",
  "usage-section.tsx",
  "activity-section.tsx",
  "virtual-models-section.tsx",
  "agents-section.tsx",
  "limits-section.tsx",
  "models-section.tsx",
  "providers-section.tsx",
];

function lineCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").length;
}

describe("console sections split", () => {
  it("moves every section component out of sections.tsx", () => {
    const source = readFileSync(`${modulesDir}/sections.tsx`, "utf8");
    expect(source).not.toMatch(/export async function \w+Section/);
  });

  it("keeps sections.tsx within the shared-helper line budget", () => {
    expect(lineCount(`${modulesDir}/sections.tsx`)).toBeLessThanOrEqual(1300);
  });

  it("gives each section its own bounded module", () => {
    for (const file of sectionFiles) {
      expect(lineCount(`${modulesDir}/${file}`), file).toBeLessThanOrEqual(1000);
    }
  });

  it("does not re-export sections from sections.tsx (no import cycle)", () => {
    const source = readFileSync(`${modulesDir}/sections.tsx`, "utf8");
    for (const file of sectionFiles) {
      expect(source).not.toContain(file.replace(".tsx", ""));
    }
  });
});
