import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const globalsCss = readFileSync(resolve(root, "apps/console/src/app/globals.css"), "utf8");

function readRule(selector: string): string {
  const start = globalsCss.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = globalsCss.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return globalsCss.slice(start, end + 2);
}

describe("feat-121 console UI polish CSS", () => {
  it("defines the polish tokens and entrance keyframes", () => {
    for (const token of ["--leading-relaxed", "--danger-strong", "--danger-fg"]) {
      expect(globalsCss.includes(`${token}:`)).toBe(true);
    }

    for (const keyframe of ["dialog-in", "scrim-in", "popover-in"]) {
      expect(globalsCss.includes(`@keyframes ${keyframe}`)).toBe(true);
    }
  });

  it("uses rendered overlay blur and existing medium elevation", () => {
    expect(readRule(".console-dialog-scrim")).toContain("backdrop-filter");
    expect(globalsCss.match(/var\(--shadow-md\)/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("removes hardcoded hex colors from the polished controls", () => {
    for (const hex of [
      "#dc2626",
      "#b91c1c",
      "#fff",
      "#0b1020",
      "#dbe7ff",
      "#f59e0b",
      "#16a34a",
      "#ef4444",
      "#7c3aed",
      "#fee2e2",
      "#dcfce7",
      "#fef3c7",
      "#ede9fe",
      "#fecaca",
      "#fca5a5",
    ]) {
      expect(globalsCss.includes(hex)).toBe(false);
    }
  });
});
