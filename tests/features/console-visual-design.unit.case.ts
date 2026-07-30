import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const consoleDir = join(process.cwd(), "apps/console");
const appDir = join(process.cwd(), "apps/console/src/app");
const publicDir = join(consoleDir, "public");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

function uiSources(): Array<readonly [string, string]> {
  return readdirSync(join(appDir, "_ui"), { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => [`_ui/${file}`, read(`_ui/${file}`)] as const);
}

describe("console visual contract", () => {
  test("both themes are declared once, as tokens, and switch on data-theme", () => {
    const css = read("globals.css");
    expect(css).toMatch(/:root \{[\s\S]*?--bg: #ffffff;/);
    expect(css).toMatch(/\[data-theme="dark"\] \{[\s\S]*?--bg: #15181c;/);
    expect(css).toContain('@custom-variant dark (&:where([data-theme="dark"]');
    // Colour lives in one table; components reference it by name.
    expect(css).toMatch(/@theme inline \{[\s\S]*?--color-accent: var\(--accent\);/);
  });

  test("no component hardcodes a colour outside the token table", () => {
    for (const [file, source] of uiSources()) {
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(source, file).not.toMatch(/\boklch\(/);
    }
  });

  test("DM Mono is never asked for a weight it does not ship", () => {
    const layout = read("layout.tsx");
    expect(layout).toContain('weight: ["300", "400", "500"]');
    for (const [file, source] of uiSources()) {
      // font-semibold/bold on a mono run would be synthesised into fake bold.
      const monoBold = source.match(/font-mono[^"'`]*font-(semibold|bold)/g) ?? [];
      expect(monoBold, file).toEqual([]);
    }
  });

  test("the theme follows the system until someone chooses otherwise", () => {
    const theme = read("_ui/theme.ts");
    expect(theme).toContain("prefers-color-scheme: dark");
    expect(theme).toContain("localStorage");
    // Stamped before paint, so a stored preference never flashes the other theme.
    expect(read("layout.tsx")).toContain('strategy="beforeInteractive"');
  });

  test("the console uses the current Oracle gate icon and ships no legacy icon", () => {
    const layout = read("layout.tsx");
    expect(layout).toContain('icon: "/llmingress-oracle-gate-logo.svg"');
    expect(layout).not.toContain("llmingress-icon.svg");
    expect(existsSync(join(publicDir, "llmingress-oracle-gate-logo.svg"))).toBe(true);
    expect(existsSync(join(publicDir, "llmingress-icon.svg"))).toBe(false);
  });

  test("shadows belong to dialogs, drawers and toasts only", () => {
    const css = read("globals.css");
    expect(css).toMatch(/--shadow-drawer:/);
    expect(css).toMatch(/--shadow-dialog:/);
    for (const [file, source] of uiSources()) {
      // An inset shadow is this system's underline for a selected tab, not a
      // drop shadow; only the raised surfaces cast one.
      const dropShadows = (source.match(/shadow-(drawer|dialog|danger|\[)/g) ?? []).filter(
        (match) => !source.includes(`${match}inset`),
      );
      if (dropShadows.length === 0) {
        continue;
      }
      expect(
        /overlay|toast|playground|auth/.test(file),
        `${file} uses a drop shadow outside an overlay`,
      ).toBe(true);
    }
  });

  test("radii stay in the 3–4px range this system uses", () => {
    const css = read("globals.css");
    expect(css).toMatch(/--radius-xs: 3px;/);
    expect(css).toMatch(/--radius-sm: 4px;/);
    for (const [file, source] of uiSources()) {
      expect(source, file).not.toMatch(/rounded-(lg|xl|2xl|3xl)\b/);
    }
  });

  test("selection and dialog state live in the query string", () => {
    for (const page of ["(dashboard)/providers/page.tsx", "(dashboard)/api-keys/page.tsx"]) {
      const source = read(page);
      expect(source, page).toContain('readParam(params, "selected")');
      expect(source, page).toContain("buildHref(");
    }
  });
});
