import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
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
    expect(sidebar).toContain("sidebar-runtime-status");
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
    expect(stylesheet).toMatch(/\.sidebar-runtime-status\s*\{[^}]*align-items:\s*center/s);
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

  test("provider add action is centered text without a leading icon", () => {
    const providersPage = readFileSync(join(appDir, "(dashboard)/providers/page.tsx"), "utf8");

    expect(providersPage).not.toContain("FlatIcon");
    expect(providersPage).toContain("<span>Add Provider</span>");
  });

  test("virtual model actions use centered text without leading icons", () => {
    const modelsPage = readFileSync(join(appDir, "(dashboard)/models/page.tsx"), "utf8");
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();
    const vmFilterForm = sections.slice(
      sections.indexOf('<form className="vm-filter-bar"'),
      sections.indexOf('<div className="vm-shell">'),
    );

    expect(modelsPage).not.toContain("FlatIcon");
    expect(modelsPage).toContain("<span>Create Virtual Model</span>");
    expect(vmFilterForm).toContain("<span>Query</span>");
    expect(vmFilterForm).not.toContain("FlatIcon");
    expect(vmFilterForm).not.toContain("<span>Apply</span>");
    expect(stylesheet).toMatch(/\.vm-filter-bar button\s*\{[^}]*min-height:\s*2\.25rem/s);
    expect(stylesheet).toMatch(
      /\.vm-filter-bar button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("activity filters use a compact text-only query button aligned with the controls", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();
    const activityFilterForm = sections.slice(
      sections.indexOf('<form className="activity-filter-grid"'),
      sections.indexOf('<div className="activity-shell">'),
    );

    expect(activityFilterForm).toContain("<span>Query</span>");
    expect(activityFilterForm).not.toContain("FlatIcon");
    expect(activityFilterForm).not.toContain("<span>Apply</span>");
    expect(stylesheet).toMatch(/\.activity-filter-grid button\s*\{[^}]*min-height:\s*2\.25rem/s);
    expect(stylesheet).toMatch(
      /\.activity-filter-grid button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("usage filters use a compact text-only query button aligned with the controls", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();
    const usageFilterForm = sections.slice(
      sections.indexOf('<form className="usage-filter-bar"'),
      sections.indexOf('<div className="stat-grid usage-kpi-grid">'),
    );

    expect(usageFilterForm).toContain("<span>Query</span>");
    expect(usageFilterForm).not.toContain("FlatIcon");
    expect(usageFilterForm).not.toContain("<span>Apply</span>");
    expect(stylesheet).toMatch(/\.usage-filter-bar button\s*\{[^}]*height:\s*2\.35rem/s);
    expect(stylesheet).toMatch(/\.usage-filter-bar button\s*\{[^}]*min-height:\s*2\.35rem/s);
    expect(stylesheet).toMatch(
      /\.usage-filter-bar button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("limit rules open configuration in a dialog from row edit actions", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();
    const limitsSection = sections.slice(
      sections.indexOf("export async function LimitsSection"),
      sections.indexOf("function LimitsConfigDialog"),
    );
    const limitsDialog = sections.slice(
      sections.indexOf("function LimitsConfigDialog"),
      sections.indexOf("function getAgentLimitRuntimeSnapshot"),
    );

    expect(limitsSection).toContain("limitDialog: row.agent.id");
    expect(limitsSection).toContain("<span>Edit</span>");
    expect(limitsSection).not.toContain("<LimitsConfigPanel");
    expect(limitsSection).not.toContain('className="table-row-link"');
    expect(limitsSection).not.toContain("is-clickable");
    expect(limitsDialog).toContain('className="console-dialog limits-config-dialog"');
    expect(limitsDialog).toContain('aria-modal="true"');
    expect(limitsDialog).toContain("<span>Save</span>");
    expect(limitsDialog).not.toContain("Save rules");
    expect(limitsDialog).not.toContain("<aside");
    expect(stylesheet).toMatch(/\.limits-main\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).not.toContain(".limits-config-panel");
  });

  test("virtual model details open in a read-only dialog instead of a side card", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();

    expect(sections).not.toContain('<aside className="agent-detail-card vm-detail-card"');
    expect(sections).toContain("virtualModelView");
    expect(sections).toContain("VirtualModelViewDialog");
    expect(sections).toContain('className="console-dialog agent-view-dialog vm-view-dialog"');
    expect(stylesheet).toMatch(/\.vm-shell\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).not.toContain(".vm-detail-card");
    expect(stylesheet).toMatch(/\.vm-view-dialog\s*\{[^}]*width:\s*min\(64rem/s);
    expect(stylesheet).toMatch(/\.vm-view-dialog\s*\{[^}]*display:\s*grid/s);
    expect(stylesheet).toMatch(
      /\.vm-view-dialog\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(stylesheet).toMatch(
      /\.vm-view-dialog \.console-dialog-head\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    );
  });

  test("virtual model edit dialog uses the full dialog width", () => {
    const routeDialog = readFileSync(
      join(appDir, "_modules/virtual-model-route-dialog.tsx"),
      "utf8",
    );
    const stylesheet = css();

    expect(routeDialog).not.toContain("vm-policy-note");
    expect(routeDialog).not.toContain("Current strategy");
    expect(stylesheet).toMatch(/\.vm-route-dialog\s*\{[^}]*width:\s*min\(56rem/s);
    expect(stylesheet).toMatch(/\.vm-route-dialog\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(stylesheet).toMatch(/\.vm-dialog-actions\s*\{[^}]*justify-content:\s*center/s);
    expect(stylesheet).toMatch(/\.vm-editor-grid\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).not.toContain(".vm-policy-note");
  });

  test("activity request details open in a dialog instead of a side panel", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();

    expect(sections).not.toContain("?? activities[0] ?? null");
    expect(sections).toContain("activityDetailCloseHref");
    expect(sections).toContain('className="console-dialog activity-detail-dialog"');
    expect(sections).toContain('aria-modal="true"');
    expect(sections).toContain("<span>Close</span>");
    expect(stylesheet).toMatch(/\.activity-shell\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).toMatch(/\.activity-detail-dialog\s*\{[^}]*width:\s*min\(48rem/s);
  });

  test("agents list opens read-only details in a dialog instead of a side card", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const stylesheet = css();

    expect(sections).not.toContain('<aside className="agent-detail-card"');
    expect(sections).toContain("agentView");
    expect(sections).toContain("AgentViewDialog");
    expect(sections).toContain('className="console-dialog agent-view-dialog"');
    expect(stylesheet).toMatch(/\.agents-shell\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).toMatch(/\.agent-view-dialog\s*\{[^}]*width:\s*min\(42rem/s);
    expect(stylesheet).toMatch(
      /\.agent-view-dialog \.agent-detail-fields\s*\{[^}]*grid-template-columns:\s*1fr/s,
    );
    expect(stylesheet).toMatch(
      /\.agent-view-dialog \.agent-detail-fields div\s*\{[^}]*grid-template-columns:\s*minmax\(8rem,\s*0\.45fr\)\s*minmax\(0,\s*1fr\)/s,
    );
  });

  test("provider default priority is removed from detail and schema", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const consoleProviders = readFileSync(
      join(rootDir, "packages/db/src/console-providers.ts"),
      "utf8",
    );
    const gatewayChatCompletions = readFileSync(
      join(rootDir, "packages/db/src/gateway-chat-completions.ts"),
      "utf8",
    );
    const baselineMigration = readFileSync(
      join(rootDir, "packages/db/migrations/0001_v1_baseline.sql"),
      "utf8",
    );

    expect(sections).not.toContain("Default priority");
    expect(sections).not.toContain("formatProviderDefaultPriority");
    expect(consoleProviders).not.toContain("defaultPriority");
    expect(consoleProviders).not.toContain("default_priority");
    expect(gatewayChatCompletions).not.toContain("providers.default_priority");
    expect(baselineMigration).not.toContain("default_priority");
  });

  test("providers list changes selection locally without route navigation", () => {
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    const providersClientSection = readFileSync(
      join(appDir, "_modules/providers-client-section.tsx"),
      "utf8",
    );

    expect(sections).toContain("ProvidersClientSection");
    expect(sections).not.toContain("const providerHref = buildQueryHref(searchParams");
    expect(providersClientSection).toContain('"use client"');
    expect(providersClientSection).toContain("useState");
    expect(providersClientSection).toContain("toggleProvider(provider.id)");
    expect(providersClientSection).toContain(
      "currentProviderId === providerId ? null : providerId",
    );
    expect(providersClientSection).toContain("const selectedProvider = selectedProviderId");
    expect(providersClientSection).toContain(
      "providers.find((provider) => provider.id === selectedProviderId)",
    );
    expect(providersClientSection).toContain('type="button"');
    expect(providersClientSection).not.toContain("href={providerHref}");
  });

  test("provider details expand inline inside the provider list", () => {
    const providersClientSection = readFileSync(
      join(appDir, "_modules/providers-client-section.tsx"),
      "utf8",
    );
    const providerModelRefreshRoute = readFileSync(
      join(appDir, "api/provider-model-refresh/route.ts"),
      "utf8",
    );
    const stylesheet = css();

    expect(providersClientSection).not.toContain("provider-detail-card");
    expect(providersClientSection).not.toContain("Provider details -");
    expect(providersClientSection).not.toContain("provider-detail-stats");
    expect(providersClientSection).not.toContain("Available models");
    expect(providersClientSection).toContain('action="/api/provider-model-refresh"');
    expect(providersClientSection).toContain("refreshProviderModels(event, provider.id)");
    expect(providersClientSection).toContain("event.preventDefault()");
    expect(providersClientSection).toContain('headers: { accept: "application/json" }');
    expect(providersClientSection).toContain("provider-refresh-button");
    expect(providersClientSection).toContain("Refresh models for");
    expect(providerModelRefreshRoute).toContain('includes("application/json")');
    expect(providersClientSection).toContain("provider-inline-detail-row");
    expect(providersClientSection).toContain("provider-inline-detail");
    expect(stylesheet).toContain(".provider-inline-detail");
    expect(stylesheet).not.toContain(".provider-detail-card");
    expect(stylesheet).not.toContain(".provider-detail-stats");
  });
});
