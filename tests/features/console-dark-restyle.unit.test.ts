import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const publicDir = join(rootDir, "apps/console/public");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const layout = () => readFileSync(join(appDir, "layout.tsx"), "utf8");
const moduleSource = (file: string) => readFileSync(join(appDir, "_modules", file), "utf8");
const consoleSectionSource = () =>
  [
    "sections.tsx",
    "overview-section.tsx",
    "runtime-section.tsx",
    "usage-section.tsx",
    "activity-section.tsx",
    "virtual-models-section.tsx",
    "route-policies-section.tsx",
    "agents-section.tsx",
    "limits-section.tsx",
    "models-section.tsx",
    "providers-section.tsx",
    "settings-section.tsx",
  ]
    .map(moduleSource)
    .join("\n");

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

  test("brand mark uses the selected SVG asset", () => {
    const stylesheet = css();
    const layoutText = layout();

    expect(existsSync(join(publicDir, "llmingress-icon.svg"))).toBe(true);
    expect(layoutText).toContain('icon: "/llmingress-icon.svg"');
    expect(stylesheet).toContain(
      'background: url("/llmingress-icon.svg") center / contain no-repeat;',
    );
    expect(stylesheet).not.toContain(".sidebar-mark::before");
  });

  test("chart palette uses the fixed chart tokens", () => {
    const palette = readFileSync(join(appDir, "_components/charts/palette.ts"), "utf8");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(palette).toContain(`var(--chart-${n})`);
    }
    expect(palette).not.toContain("color-mix");
    const sections = consoleSectionSource();
    expect(sections).not.toMatch(/"#[0-9a-fA-F]{6}"/);
  });

  test("overview gateway details live in the sidebar runtime card", () => {
    const sections = consoleSectionSource();
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

  test("agents filters use a compact filter button aligned with the controls", () => {
    const agentsPage = readFileSync(join(appDir, "(dashboard)/agents/page.tsx"), "utf8");
    const sections = moduleSource("agents-section.tsx");
    const stylesheet = css();

    expect(sections).not.toContain("Apply filters");
    expect(sections).toContain("<span>Filter</span>");
    expect(sections).not.toContain("<span>Query</span>");
    expect(sections).not.toContain(
      '<FlatIcon name="filter" />\n                  <span>Filter</span>',
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

  test("virtual model actions use compact icon row actions", () => {
    const modelsPage = readFileSync(join(appDir, "(dashboard)/models/page.tsx"), "utf8");
    const sections = moduleSource("virtual-models-section.tsx");
    const stylesheet = css();
    const vmFilterForm = sections.slice(
      sections.indexOf('<form className="vm-filter-bar"'),
      sections.indexOf('<div className="vm-shell">'),
    );
    const vmTable = sections.slice(
      sections.indexOf('<table className="data-table vm-table">'),
      sections.indexOf("</table>", sections.indexOf('<table className="data-table vm-table">')),
    );

    expect(modelsPage).not.toContain("FlatIcon");
    expect(modelsPage).toContain('className="page models-page"');
    expect(modelsPage).toContain("<span>Create Virtual Model</span>");
    expect(vmFilterForm).toContain("<span>Filter</span>");
    expect(vmFilterForm).not.toContain("<span>Query</span>");
    expect(vmFilterForm).not.toContain("FlatIcon");
    expect(vmFilterForm).not.toContain("<span>Apply</span>");
    expect(vmTable).toContain('className="agent-table-actions"');
    expect(vmTable).toContain('className="link-button agent-action-edit row-action-button"');
    expect(vmTable).toContain('<FlatIcon name="edit" />');
    expect(vmTable).not.toContain('className="table-action-link"');
    expect(stylesheet).toMatch(
      /\.providers-page,\s*\.models-page,\s*\.runtime-page,\s*\.settings-page\s*\{[^}]*margin:\s*0/s,
    );
    expect(stylesheet).toMatch(/\.vm-filter-bar button\s*\{[^}]*min-height:\s*2\.25rem/s);
    expect(stylesheet).toMatch(
      /\.vm-filter-bar button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("utility console pages use the left-aligned console shell", () => {
    const runtimePage = readFileSync(join(appDir, "(dashboard)/runtime/page.tsx"), "utf8");
    const settingsPage = readFileSync(join(appDir, "(dashboard)/settings/page.tsx"), "utf8");
    const stylesheet = css();

    expect(runtimePage).toContain('className="page runtime-page"');
    expect(settingsPage).toContain('className="page settings-page"');
    expect(stylesheet).toMatch(
      /\.providers-page,\s*\.models-page,\s*\.runtime-page,\s*\.settings-page\s*\{[^}]*margin:\s*0/s,
    );
  });

  test("activity filters use a compact text-only filter button aligned with the controls", () => {
    const sections = moduleSource("activity-section.tsx");
    const stylesheet = css();
    const activityFilterForm = sections.slice(
      sections.indexOf('<form className="activity-filter-grid"'),
      sections.indexOf('<div className="activity-shell">'),
    );

    expect(activityFilterForm).toContain("<span>Filter</span>");
    expect(activityFilterForm).not.toContain("<span>Query</span>");
    expect(activityFilterForm).not.toContain("FlatIcon");
    expect(activityFilterForm).not.toContain("<span>Apply</span>");
    expect(stylesheet).toMatch(/\.activity-filter-grid button\s*\{[^}]*min-height:\s*2\.25rem/s);
    expect(stylesheet).toMatch(
      /\.activity-filter-grid button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("usage filters use a compact text-only filter button aligned with the controls", () => {
    const sections = moduleSource("usage-section.tsx");
    const stylesheet = css();
    const usageFilterForm = sections.slice(
      sections.indexOf('<form className="usage-filter-bar"'),
      sections.indexOf('<div className="stat-grid usage-kpi-grid">'),
    );

    expect(usageFilterForm).toContain("<span>Filter</span>");
    expect(usageFilterForm).not.toContain("<span>Query</span>");
    expect(usageFilterForm).not.toContain("FlatIcon");
    expect(usageFilterForm).not.toContain("<span>Apply</span>");
    expect(stylesheet).toMatch(/\.usage-filter-bar button\s*\{[^}]*height:\s*2\.55rem/s);
    expect(stylesheet).toMatch(/\.usage-filter-bar button\s*\{[^}]*min-height:\s*2\.55rem/s);
    expect(stylesheet).toMatch(
      /\.usage-filter-bar button\s*\{[^}]*padding-block:\s*var\(--space-xs\)/s,
    );
  });

  test("playground actions show Clear before Send", () => {
    const playground = readFileSync(join(appDir, "playground.tsx"), "utf8");
    const actions = playground.slice(
      playground.indexOf('<div className="console-actions playground-actions">'),
      playground.indexOf(
        "</div>",
        playground.indexOf('<div className="console-actions playground-actions">'),
      ),
    );

    expect(actions.indexOf("<span>Clear</span>")).toBeLessThan(actions.indexOf('"Send"'));
    expect(actions).toContain('"Send"');
    expect(actions).not.toContain("Send test");
    expect(actions).not.toContain("FlatIcon");

    const stylesheet = readFileSync(join(appDir, "globals.css"), "utf8");
    expect(stylesheet).toMatch(/\.playground-actions\s*\{[^}]*justify-content:\s*flex-end/s);
    expect(stylesheet).toMatch(/\.playground-actions button\s*\{[^}]*justify-content:\s*center/s);
  });

  test("settings notification channel submit is a compact centered Save button", () => {
    const sections = moduleSource("settings-section.tsx");
    const stylesheet = css();
    const notificationForm = sections.slice(
      sections.indexOf('action="/api/notification-channels"'),
      sections.indexOf("</form>", sections.indexOf('action="/api/notification-channels"')),
    );

    expect(notificationForm).toContain('className="notification-channel-save-button"');
    expect(notificationForm).toContain("<span>Save</span>");
    expect(notificationForm).not.toContain("Create webhook notification channel");
    expect(notificationForm).not.toContain("FlatIcon");
    expect(stylesheet).toMatch(
      /\.notification-channel-save-button\s*\{[^}]*justify-self:\s*center/s,
    );
    expect(stylesheet).toMatch(/\.notification-channel-save-button\s*\{[^}]*min-width:\s*6rem/s);
  });

  test("dialog form submit buttons stay compact and text-only", () => {
    const agentSection = moduleSource("agents-section.tsx");
    const sections = consoleSectionSource();
    const providerCreateForm = readFileSync(
      join(appDir, "_modules/provider-create-form.tsx"),
      "utf8",
    );
    const routeDialog = readFileSync(
      join(appDir, "_modules/virtual-model-route-dialog.tsx"),
      "utf8",
    );
    const stylesheet = css();
    const agentCreateForm = agentSection.slice(
      agentSection.indexOf('action="/api/agents" id="new-agent"'),
      agentSection.indexOf("</form>", agentSection.indexOf('action="/api/agents" id="new-agent"')),
    );
    const providerCreateSubmit = providerCreateForm.slice(
      providerCreateForm.lastIndexOf('<button type="submit">'),
      providerCreateForm.indexOf(
        "</button>",
        providerCreateForm.lastIndexOf('<button type="submit">'),
      ),
    );

    expect(agentCreateForm).toContain("<span>Create</span>");
    expect(agentCreateForm).not.toContain("FlatIcon");
    expect(providerCreateSubmit).toContain("<span>Create</span>");
    expect(providerCreateSubmit).not.toContain("FlatIcon");
    expect(sections).not.toContain("Save provider");
    expect(sections).not.toContain("Save API key");
    expect(sections).not.toContain("Save price override");
    expect(routeDialog).toContain("<span>Add Model</span>");
    expect(routeDialog).not.toContain('<FlatIcon name="add" />');
    expect(stylesheet).toMatch(
      /\.provider-create-form > button\[type="submit"\][^}]*\{[^}]*justify-self:\s*end/s,
    );
    expect(stylesheet).toMatch(/\.vm-add-model-button\s*\{[^}]*align-self:\s*center/s);
  });

  test("limit rules open configuration in a dialog from row edit actions", () => {
    const sections = moduleSource("limits-section.tsx");
    const stylesheet = css();
    const limitsSection = sections.slice(
      sections.indexOf("export async function LimitsSection"),
      sections.length,
    );
    const limitsDialog = sections.slice(
      sections.indexOf("function LimitsConfigDialog"),
      sections.indexOf("function LimitsDeleteDialog"),
    );
    const limitsActions = limitsDialog.slice(
      limitsDialog.indexOf('<div className="limits-config-actions">'),
      limitsDialog.indexOf(
        "</div>",
        limitsDialog.indexOf('<div className="limits-config-actions">'),
      ),
    );

    expect(limitsSection).toContain("limitDialog: row.agent.id");
    expect(limitsSection).toContain('<FlatIcon name="edit" />');
    expect(limitsSection).toContain('className="agent-table-actions"');
    expect(limitsSection).toContain('className="link-button agent-action-edit row-action-button"');
    expect(limitsSection).not.toContain('className="table-action-link"');
    expect(limitsSection).not.toContain("<LimitsConfigPanel");
    expect(limitsSection).not.toContain('className="table-row-link"');
    expect(limitsSection).not.toContain("is-clickable");
    expect(limitsDialog).toContain('className="console-dialog limits-config-dialog"');
    expect(limitsDialog).toContain('aria-modal="true"');
    expect(limitsDialog).toContain("<span>Save</span>");
    expect(limitsDialog).not.toContain("Save rules");
    expect(limitsDialog).not.toContain("formatLimitsKeyPrefix(agent.keyPrefix)");
    expect(limitsActions).not.toContain("FlatIcon");
    expect(limitsDialog).not.toContain("<aside");
    expect(stylesheet).toMatch(/\.limits-main\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).toMatch(/\.limits-config-actions\s*\{[^}]*justify-content:\s*flex-end/s);
    expect(stylesheet).toMatch(
      /\.limits-config-actions :is\(button, \.secondary-button\)\s*\{[^}]*width:\s*7\.25rem/s,
    );
    expect(stylesheet).not.toContain(".limits-config-panel");
  });

  test("virtual model details open in a read-only dialog instead of a side card", () => {
    const sections = moduleSource("virtual-models-section.tsx");
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
    expect(stylesheet).toMatch(/\.vm-dialog-actions\s*\{[^}]*justify-content:\s*flex-end/s);
    expect(stylesheet).toMatch(/\.vm-editor-grid\s*\{[^}]*display:\s*block/s);
    expect(stylesheet).not.toContain(".vm-policy-note");
  });

  test("activity request details open in a dialog instead of a side panel", () => {
    const sections = moduleSource("activity-section.tsx");
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
    const sections = moduleSource("agents-section.tsx");
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
    const sections = consoleSectionSource();
    const consoleProviders = readFileSync(
      join(rootDir, "packages/db/src/console-providers.ts"),
      "utf8",
    );
    const gatewayChatCompletions = readFileSync(
      join(rootDir, "packages/gateway-runtime/src/gateway-chat-completions.ts"),
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
    const sections = moduleSource("providers-section.tsx");
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
    const providerJobs = readFileSync(join(rootDir, "packages/db/src/provider-jobs.ts"), "utf8");
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
    expect(providersClientSection).toContain(
      "!provider.enabled || providerKeyCount === 0 || isRefreshing",
    );
    expect(providersClientSection).toContain("Enable provider to refresh models");
    expect(providerModelRefreshRoute).toContain('includes("application/json")');
    expect(providerJobs).toContain("Provider must be enabled before refreshing models.");
    expect(providersClientSection).toContain("provider-inline-detail-row");
    expect(providersClientSection).toContain("provider-inline-detail");
    expect(stylesheet).toContain(".provider-inline-detail");
    expect(stylesheet).not.toContain(".provider-detail-card");
    expect(stylesheet).not.toContain(".provider-detail-stats");
  });
});
