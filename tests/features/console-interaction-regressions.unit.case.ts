import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConsoleUsageWindow } from "../../packages/db/src/console-usage";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");

const source = (path: string) => readFileSync(join(rootDir, path), "utf8");
const appSource = (path: string) => readFileSync(join(appDir, path), "utf8");
const sectionSource = (file: string) => appSource(`_modules/${file}`);
const consoleSectionSource = () =>
  [
    "sections.tsx",
    "overview-section.tsx",
    "usage-section.tsx",
    "activity-section.tsx",
    "virtual-models-section.tsx",
    "agents-section.tsx",
    "limits-section.tsx",
    "models-section.tsx",
    "providers-section.tsx",
  ]
    .map(sectionSource)
    .join("\n");
const css = () => appSource("globals.css");

describe("console UI audit confirmed fixes static contract", () => {
  test("sidebar and wide list pages use the shared desktop layout scale", () => {
    const stylesheet = css();
    expect(stylesheet).toMatch(/--sidebar-width:\s*17\.5rem/);
    expect(stylesheet).toMatch(/\.nav-item-label\s*\{[^}]*font-size:\s*var\(--text-base\)/s);
    expect(stylesheet).toMatch(/\.limits-page\s*\{[^}]*max-width:\s*100rem/s);
    expect(stylesheet).toMatch(/\.activity-page\s*\{[^}]*max-width:\s*100rem/s);
  });

  test("activity uses a dedicated twenty-row page size", () => {
    const activity = sectionSource("activity-section.tsx");
    expect(activity).toContain("const ACTIVITY_PAGE_SIZE = 20;");
    expect(activity).toContain("limit: ACTIVITY_PAGE_SIZE");
    expect(activity).toContain("Math.ceil(total / ACTIVITY_PAGE_SIZE)");
  });

  test("activity timestamp cells cannot paint into request id cells", () => {
    const stylesheet = css();
    expect(stylesheet).toMatch(
      /\.activity-table th:nth-child\(1\),\s*\.activity-table td:nth-child\(1\)\s*\{[^}]*width:\s*8\.\d+rem/s,
    );
    expect(stylesheet).toMatch(
      /\.activity-table td:nth-child\(1\)\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
    );
    expect(stylesheet).toMatch(
      /\.activity-table td:nth-child\(2\)\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
    );
  });

  test("usage defaults to the settings time window", () => {
    expect(parseConsoleUsageWindow(undefined)).toBe("7d");
    expect(parseConsoleUsageWindow("")).toBe("7d");
  });

  test("overview does not mix all-time recent activity into 24h cards", () => {
    const overview = sectionSource("overview-section.tsx");
    expect(overview).toContain("listConsoleActivities({");
    expect(overview).toContain("filters: { from: overviewStart }");
    expect(overview).toContain("limit: 8");
    expect(overview).not.toContain("const activities = await listConsoleActivities();");
    expect(overview).not.toContain(
      "buildTopAgentsByCost(usageSummary.agentBreakdowns, recentActivities)",
    );
  });

  test("stat labels describe the data they actually show", () => {
    const sourceText = consoleSectionSource();
    expect(sourceText).toContain('label="Enabled"');
    expect(sourceText).toContain('label="Cost 24h"');
    expect(sourceText).toContain('label="Failure rate total"');
    expect(sourceText).toContain('<th className="num">Failure rate total</th>');
    expect(sourceText).not.toContain('label="Connected"');
    expect(sourceText).not.toContain('label="Cost 7d"');
    expect(sourceText).not.toContain('label="Avg failure rate"');
  });

  test("agent forms use display labels and checkbox grants", () => {
    const sourceText = sectionSource("agents-section.tsx");
    const virtualModelFields = sectionSource("agent-virtual-model-fields.tsx");
    const agentFormsSource = sourceText.slice(
      sourceText.indexOf("function AgentCreateDialog"),
      sourceText.indexOf("function AgentDeleteDialog"),
    );
    expect(sourceText).not.toContain("Edit agent name");
    expect(sourceText).not.toContain("Edit agent type");
    expect(sourceText).not.toContain("Edit integration platform");
    expect(sourceText).not.toContain("Edit request logging");
    expect(sourceText).not.toContain('<option value="coding">coding</option>');
    expect(sourceText).not.toContain('<option value="terminal">terminal</option>');
    expect(sourceText).not.toContain('<option value="true">enabled</option>');
    expect(agentFormsSource).not.toContain('<option value="day">day</option>');
    expect(agentFormsSource).not.toContain('<option value="week">week</option>');
    expect(agentFormsSource).not.toContain('<option value="month">month</option>');
    expect(sourceText).not.toContain('name="agentType"');
    expect(sourceText).not.toContain('name="requestLoggingEnabled"');
    expect(agentFormsSource).toContain('<option value="day">Day</option>');
    expect(agentFormsSource).toContain('<option value="week">Week</option>');
    expect(agentFormsSource).toContain('<option value="month">Month</option>');
    expect(virtualModelFields).toContain('type="checkbox"');
    expect(virtualModelFields).toContain('name="allowedVirtualModelIds"');
    expect(virtualModelFields).toContain("selectedVirtualModelIds.has(virtualModel.id)");
    expect(agentFormsSource).not.toContain("multiple\n");
  });

  test("row actions share a compact icon-button contract", () => {
    const sourceText = consoleSectionSource();
    const providerSource = appSource("_modules/providers-client-section.tsx");
    expect(css()).toContain(".row-action-button");
    expect(sourceText.match(/row-action-button/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(providerSource.match(/row-action-button/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(sourceText).toContain("row-action-danger");
    expect(providerSource).toContain("row-action-danger");
  });

  test("Provider API key row mutations refresh on AJAX success and use a detached error toast", () => {
    const mutationForm = appSource("_components/console-mutation-form.tsx");
    const providerClient = sectionSource("providers-client-section.tsx");
    const providerServer = sectionSource("providers-section.tsx");
    const providerKeyRoute = source("apps/console/src/app/api/provider-keys/route.ts");
    const stylesheet = css();

    expect(providerKeyRoute).toContain(
      'request.headers.get("accept")?.includes("application/json")',
    );
    expect(providerKeyRoute).toContain("return new NextResponse(null, { status: 204 });");
    expect(providerKeyRoute).toContain("return NextResponse.redirect(");
    expect(providerKeyRoute).toContain("303,");
    expect(mutationForm).toContain('errorPresentation?: "inline" | "toast"');
    expect(mutationForm).toContain("successHref?: string");
    expect(mutationForm).toContain('className="console-mutation-toast"');
    expect(mutationForm).toContain('popover="manual"');
    expect(mutationForm).toContain('aria-label="Dismiss error"');
    expect(mutationForm).toContain("5_000");
    expect(providerClient).toContain('errorPresentation="toast"');
    expect(providerServer).toContain('errorPresentation="toast"');
    expect(providerServer).toContain("successHref={closeHref}");
    expect(stylesheet).toMatch(
      /\.console-mutation-toast\s*\{[^}]*position:\s*fixed[^}]*top:[^}]*right:[^}]*z-index:\s*70/s,
    );
  });

  test("page headers and dialog close actions are consistent", () => {
    expect(source("apps/console/src/app/(dashboard)/usage/page.tsx")).not.toContain("eyebrow=");
    const limitsSource = sectionSource("limits-section.tsx");
    const limitsDialogHead = limitsSource.slice(
      limitsSource.indexOf('className="console-dialog-head limits-config-head"'),
      limitsSource.indexOf('<form className="limits-config-form"'),
    );
    expect(limitsDialogHead).toContain('<FlatIcon name="cancel" />');
  });

  test("virtual model search tolerates pre-hydration browser caret mutations", () => {
    const sourceText = sectionSource("virtual-models-section.tsx");
    const searchInput = sourceText.slice(
      sourceText.indexOf('aria-label="Search Virtual Model Name"'),
      sourceText.indexOf('defaultValue={readSingleSearchParam(searchParams.vmQuery) ?? ""}') + 160,
    );
    expect(searchInput).toContain("suppressHydrationWarning");
  });

  test("playground API key hint matches LLMIngress keys", () => {
    expect(appSource("playground.tsx")).toContain('placeholder="llmi_************************"');
    expect(appSource("playground.tsx")).not.toContain("sk-************************8fA7");
  });

  test("activity strategy labels and limits search stay user-facing", () => {
    const activity = sectionSource("activity-section.tsx");
    const limits = sectionSource("limits-section.tsx");

    expect(activity).toContain('cost_first: "Cost First"');
    expect(activity).toContain("routeStrategyLabels[routeReason.strategy]");
    expect(limits).toMatch(
      /className="limits-search-form"[\s\S]*?<button[^>]*type="submit"[^>]*>[\s\S]*?Search[\s\S]*?<\/button>/,
    );
  });
});
