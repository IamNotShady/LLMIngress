import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");

describe("console P0 layout static contract", () => {
  test("chart cards cannot widen their grid track past the container", () => {
    // Grid/flex items default to min-width:auto, so a nowrap table inside a
    // chart card blows the track out to the table's intrinsic width.
    expect(css()).toMatch(/\.chart-card\s*\{[^}]*min-width:\s*0/s);
  });

  test("mobile detail-layout override keeps the zero-minimum track", () => {
    // A bare `1fr` track resolves to minmax(auto, 1fr), which reintroduces
    // the intrinsic-width blowout the desktop minmax(0, …) tracks prevent.
    expect(css()).toMatch(
      /\.detail-layout,\s*\.overview-dashboard \.detail-layout,\s*\.agents-shell\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  test("limits rules table fits the 1280px content column", () => {
    // 64rem (1024px) exceeded the ~930px content column at 1280 and clipped
    // the row actions behind the card edge.
    expect(css()).toMatch(/\.limits-rule-table\s*\{[^}]*min-width:\s*56rem/s);
    expect(css()).not.toMatch(/\.limits-rule-table\s*\{[^}]*min-width:\s*64rem/s);
  });

  test("trend chart renders an explicit empty state for empty windows", () => {
    const chart = readFileSync(join(appDir, "_components/charts/trend-line-chart.tsx"), "utf8");
    expect(chart).toContain("data.length === 0");
    expect(chart).toContain("chart-empty");
    expect(chart).toContain("emptyMessage");
    expect(css()).toMatch(/\.chart-empty\s*\{[^}]*place-items:\s*center/s);
  });

  test("sidebar exposes a mobile menu toggle that hides nav until opened", () => {
    const sidebar = readFileSync(join(appDir, "_components/sidebar.tsx"), "utf8");
    expect(sidebar).toContain("sidebar-menu-toggle");
    expect(sidebar).toContain("aria-expanded");
    expect(sidebar).toContain('aria-controls="console-sidebar-nav"');
    expect(sidebar).toContain("is-menu-open");
    // Drawer closes again after client-side navigation.
    expect(sidebar).toMatch(/useEffect\(\(\) => \{\s*setMenuOpen\(false\);\s*\}, \[pathname\]\)/);

    const stylesheet = css();
    // Hidden on desktop, shown inside the collapsed top bar.
    expect(stylesheet).toMatch(/\.sidebar-menu-toggle\s*\{[^}]*display:\s*none/s);
    expect(stylesheet).toMatch(
      /\.sidebar:not\(\.is-menu-open\) \.sidebar-nav,\s*\.sidebar:not\(\.is-menu-open\) \.sidebar-footer\s*\{\s*display:\s*none/,
    );
  });
});
