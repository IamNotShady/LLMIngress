import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console in-flight feedback", () => {
  test("the playground reports an in-flight send and cannot be double-submitted", () => {
    const src = read("_ui/playground/playground.tsx");
    expect(src).toMatch(/Sending…/);
    expect(src).toMatch(/disabled=\{sending/);
  });

  test("skeleton rows announce what is loading rather than spinning silently", () => {
    const src = read("_ui/layout.tsx");
    expect(src).toMatch(/export function LoadingRows/);
    expect(src).toMatch(/note/);
  });

  test("no animation runs without honouring reduced motion", () => {
    const css = read("globals.css");
    const animations = css.match(/animation:/g) ?? [];
    if (animations.length > 0) {
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    }
    // The console's only motion is the theme knob, which is a 150ms position
    // transition rather than a looping animation.
    expect(css).not.toMatch(/@keyframes/);
  });
});
