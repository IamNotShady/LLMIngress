import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console success toast", () => {
  test("mutation form renders a success-tone toast variant", () => {
    const src = read("_components/console-mutation-form.tsx");
    expect(src).toMatch(/console-mutation-toast--success/);
    expect(src).toMatch(/tone === "success"/);
    expect(src).toMatch(/role=\{tone === "success" \? "status" : "alert"\}/);
    expect(src).toMatch(/successMessage/);
    expect(src).toMatch(/setSuccess/);
  });

  test("stylesheet defines the success toast variant with ok tokens", () => {
    const css = read("globals.css");
    expect(css).toMatch(/\.console-mutation-toast--success\s*\{[\s\S]*?var\(--ok\)/);
    expect(css).toMatch(/\.console-mutation-toast--success\s*\{[\s\S]*?var\(--surface-raised\)/);
  });

  test("a refresh-path mutation opts into the success toast", () => {
    const src = read("_modules/providers-client-section.tsx");
    expect(src).toMatch(/successMessage=/);
  });
});
