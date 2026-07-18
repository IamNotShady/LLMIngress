import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console spinner primitive", () => {
  test("exports an accessible Spinner with a stable class and no hardcoded color", () => {
    const src = read("_components/spinner.tsx");
    expect(src).toMatch(/export function Spinner/);
    expect(src).toMatch(/className="spinner"/);
    expect(src).toMatch(/role="status"/);
    expect(src).toMatch(/aria-label/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("stylesheet animates the spinner and respects reduced motion", () => {
    const css = read("globals.css");
    expect(css).toMatch(/\.spinner\s*\{/);
    expect(css).toMatch(/@keyframes spinner-rotate/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.spinner-ring/);
  });

  test("playground uses the shared Spinner for in-flight states", () => {
    const src = read("playground.tsx");
    expect(src).toMatch(/from "\.\/_components\/spinner"/);
    expect(src).toMatch(/<Spinner/);
  });
});
