import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const layout = () => readFileSync(join(appDir, "layout.tsx"), "utf8");

describe("console dark restyle static contract", () => {
  test("globals.css defines a single dark-only token layer", () => {
    const text = css();
    // No theme switching selectors remain.
    expect(text).not.toMatch(/\[data-theme=/);
    // Dark canvas: OKLCH lightness below 0.2.
    expect(text).toMatch(/--canvas:\s*oklch\(0\.1\d*\s/);
    // Violet accent hue anchor.
    expect(text).toMatch(/--hue:\s*288\b/);
    // Hairline + glow tokens exist.
    expect(text).toContain("--hairline:");
    expect(text).toContain("--glow-accent:");
    // Fixed categorical chart tokens.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(text).toContain(`--chart-${n}:`);
    }
  });

  test("buttons are compact (30px), not the old 44px", () => {
    expect(css()).toMatch(/min-height:\s*1\.875rem/);
    expect(css()).not.toMatch(/min-height:\s*2\.75rem/);
  });

  test("layout serves Geist fonts and a hardcoded dark theme", () => {
    const text = layout();
    expect(text).toMatch(/Geist,?\s/);
    expect(text).toContain("Geist_Mono");
    expect(text).not.toContain("Bricolage_Grotesque");
    expect(text).not.toContain("Hanken_Grotesk");
    expect(text).not.toContain("Spline_Sans_Mono");
    expect(text).toContain('data-theme="dark"');
    // Theme persistence bootstrap is gone.
    expect(text).not.toContain("llmingress-theme");
    expect(text).not.toContain("prefers-color-scheme");
  });

  test("theme toggle component is deleted and unreferenced", () => {
    expect(existsSync(join(appDir, "_components/theme-toggle.tsx"))).toBe(false);
    const sidebar = readFileSync(join(appDir, "_components/sidebar.tsx"), "utf8");
    expect(sidebar).not.toContain("ThemeToggle");
    expect(css()).not.toContain(".theme-toggle");
  });

  test("chart palette uses the fixed chart tokens", () => {
    const palette = readFileSync(join(appDir, "_components/charts/palette.ts"), "utf8");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(palette).toContain(`var(--chart-${n})`);
    }
    expect(palette).not.toContain("color-mix");
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    expect(sections).not.toMatch(/"#[0-9a-fA-F]{6}"/);
  });

  test("overview gateway details live in the sidebar runtime card", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const sidebar = readFileSync(join(appDir, "_components/sidebar.tsx"), "utf8");
    expect(sections).not.toContain('<h2 className="detail-panel-title">Gateway status</h2>');
    expect(sidebar).toContain("Gateway URL");
    expect(sidebar).toContain("Uptime");
    expect(sidebar).toContain("Providers");
    expect(sidebar).toContain("sidebar-provider-health-count");
  });

  test("shell keeps gateway chrome only in the sidebar runtime card", () => {
    const topbar = readFileSync(join(appDir, "_components/topbar.tsx"), "utf8");
    const sidebar = readFileSync(join(appDir, "_components/sidebar.tsx"), "utf8");
    const stylesheet = css();

    expect(topbar).not.toContain("topbar-status");
    expect(topbar).not.toContain("topbar-link");
    expect(topbar).not.toContain("Help");
    expect(sidebar).not.toContain("Signed in as admin");
    expect(sidebar).not.toContain('className="sidebar-account"');
    expect(stylesheet).not.toContain(".topbar-status");
    expect(stylesheet).not.toContain(".topbar-link");
    expect(stylesheet).not.toContain(".sidebar-account {");
    expect(stylesheet).toMatch(/\.sidebar-runtime-card\s*\{[^}]*min-height:\s*8\.5rem/s);
    expect(stylesheet).toMatch(/\.sidebar-runtime-summary\s*\{[^}]*gap:\s*0\.18rem/s);
  });

  test("agents filters use a compact query button aligned with the controls", () => {
    const agentsPage = readFileSync(join(appDir, "(dashboard)/agents/page.tsx"), "utf8");
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();

    expect(sections).not.toContain("Apply filters");
    expect(sections).toContain("<span>Query</span>");
    expect(sections).not.toContain(
      '<FlatIcon name="filter" />\n                  <span>Query</span>',
    );
    expect(agentsPage).not.toContain("FlatIcon");
    expect(agentsPage).toContain("<span>Create Agent</span>");
    expect(stylesheet).toMatch(/\.agents-filter-actions button\s*\{[^}]*min-height:\s*2\.25rem/s);
    expect(stylesheet).toMatch(
      /\.agents-filter-actions button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("agents list opens read-only details in a dialog instead of a side card", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();

    expect(sections).not.toContain('<aside className="agent-detail-card"');
    expect(sections).toContain("agentView");
    expect(sections).toContain("AgentViewDialog");
    expect(sections).toContain('className="console-dialog agent-view-dialog"');
    expect(stylesheet).toMatch(/\.agents-shell\s*\{[^}]*display:\s*block/s);
  });
});
