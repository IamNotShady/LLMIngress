import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console empty-state primitive", () => {
  test("exports an EmptyState block with a stable class and no hardcoded color", () => {
    const src = read("_components/empty-state.tsx");
    expect(src).toMatch(/export function EmptyState/);
    expect(src).toMatch(/className="empty-state"/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("stylesheet defines the empty-state container using tokens", () => {
    const css = read("globals.css");
    expect(css).toMatch(/\.empty-state\s*\{[^}]*var\(--space-/s);
    expect(css).toMatch(/\.empty-state-title\s*\{/);
  });

  test("dashboard sections consume the shared EmptyState", () => {
    for (const file of [
      "_modules/providers-client-section.tsx",
      "_modules/models-section.tsx",
      "_modules/overview-section.tsx",
      "_modules/activity-section.tsx",
      "_modules/limits-section.tsx",
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/from "[^"]*empty-state"/);
      expect(src, file).toMatch(/<EmptyState/);
    }
  });
});
