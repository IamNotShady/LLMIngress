import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console empty-state primitive", () => {
  test("exports one EmptyState block and hardcodes no colour", () => {
    const src = read("_ui/layout.tsx");
    expect(src).toMatch(/export function EmptyState/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("every module that can be empty renders the shared block", () => {
    for (const file of [
      "(dashboard)/page.tsx",
      "(dashboard)/providers/page.tsx",
      "(dashboard)/models/page.tsx",
      "(dashboard)/api-keys/page.tsx",
      "(dashboard)/limits/page.tsx",
      "(dashboard)/activity/page.tsx",
      "(dashboard)/usage/page.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/<EmptyState/);
    }
  });

  test("a filtered view that returns nothing is not the same as an empty console", () => {
    const activity = read("(dashboard)/activity/page.tsx");
    // Both states exist, and the filtered one offers a way back out.
    expect(activity).toContain("No requests match these filters");
    expect(activity).toContain("No requests yet");
    expect(activity).toContain("Clear filters");
  });
});
