import { readdirSync, readFileSync } from "node:fs";
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

  test("the one spinner is shared, named, and drops its motion when asked", () => {
    const spinner = read("_ui/spinner.tsx");
    // A spinner that does not say what it is waiting on tells nobody anything.
    expect(spinner).toMatch(/aria-label=\{label\}/);
    expect(spinner).toMatch(/motion-reduce:animate-none/);

    // Nothing else spins: one primitive, used where a wait is client-side.
    const uiFiles = readdirSync(join(appDir, "_ui"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".tsx") && !file.endsWith("spinner.tsx"));
    for (const file of uiFiles) {
      expect(read(`_ui/${file}`), file).not.toMatch(/animate-spin/);
    }
  });
});
