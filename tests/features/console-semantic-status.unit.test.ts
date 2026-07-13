import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const sectionSource = (file: string) => readFileSync(join(appDir, "_modules", file), "utf8");
const sections = () =>
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
const statCard = () => readFileSync(join(appDir, "_components/stat-card.tsx"), "utf8");
const providersSection = () =>
  readFileSync(join(appDir, "_modules/providers-client-section.tsx"), "utf8");

// Slice the StatCard call that carries the given label so assertions read the
// right card's props.
function statCardBlock(source: string, label: string): string {
  const start = source.indexOf(`label="${label}"`);
  expect(start, `StatCard label="${label}" exists`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("/>", start));
}

describe("console semantic status static contract", () => {
  test("stat card deltas speak valence (good/bad/neutral), not direction", () => {
    expect(statCard()).toContain('"good" | "bad" | "neutral"');
    expect(statCard()).toContain("valueTone");
    expect(statCard()).not.toContain('"up" | "down"');

    const stylesheet = css();
    expect(stylesheet).toMatch(/\.stat-card-delta\.is-good\s*\{[^}]*var\(--ok\)/s);
    expect(stylesheet).toMatch(/\.stat-card-delta\.is-bad\s*\{[^}]*var\(--danger\)/s);
    expect(stylesheet).toMatch(/\.stat-card-delta\.is-neutral\s*\{[^}]*var\(--text-subtle\)/s);
    expect(stylesheet).not.toContain(".stat-card-delta.is-up");
    expect(stylesheet).not.toContain(".stat-card-delta.is-down");
    expect(stylesheet).toMatch(/\.stat-card-value\.is-danger\s*\{[^}]*var\(--danger\)/s);
    expect(stylesheet).toMatch(/\.stat-card-value\.is-warn\s*\{[^}]*var\(--warn\)/s);
  });

  test("overview KPI deltas carry per-metric polarity", () => {
    const source = sections();
    expect(source).toContain('"up-good" | "down-good"');
    expect(statCardBlock(source, "Requests 24h")).toContain('"up-good"');
    expect(statCardBlock(source, "Cost 24h")).toContain('"down-good"');
    expect(statCardBlock(source, "Tokens 24h")).toContain('"up-good"');
    expect(statCardBlock(source, "Failure rate")).toContain('"down-good"');
    expect(statCardBlock(source, "Over-limit today")).toContain('"down-good"');
  });

  test("failure rates at alert thresholds render warn/danger", () => {
    const source = sections();
    expect(source).toContain("function failureRateTone");
    expect(source).toContain(">= 0.2");
    expect(source).toContain(">= 0.05");
    // Overview, Usage, and Virtual Models KPIs plus both failure-rate table
    // cells consume the tone helper.
    expect(source.match(/failureRateTone\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);

    const stylesheet = css();
    expect(stylesheet).toMatch(/\.num-danger\s*\{[^}]*var\(--danger\)/s);
    expect(stylesheet).toMatch(/\.num-warn\s*\{[^}]*var\(--warn\)/s);
  });

  test("disabled providers and models wear neutral chips, not error red", () => {
    // The provider list/detail pill short-circuits the disabled state before
    // the danger fallback; no rendering path paints Disabled in danger red.
    // (The duplicate sections.tsx pill left with the provider card grid.)
    const providerSource = providersSection();
    expect(providerSource).toContain('<span className="pill">Disabled</span>');
    expect(providerSource).not.toContain('pill--danger pill">Disabled');
    const pillFn = providerSource.slice(
      providerSource.indexOf("function ProviderStatusPill"),
      providerSource.indexOf("function formatProviderHealthStatusLabel"),
    );
    expect(pillFn).toContain('normalized === "disabled"');
    expect(sections()).not.toContain('pill--danger pill">Disabled');
  });

  test("row-level destructive emphasis is limited to supported delete actions", () => {
    const stylesheet = css();
    expect(stylesheet).toMatch(
      /\.agent-table-actions \.agent-action-delete\s*\{[^}]*background:\s*transparent/s,
    );
    expect(stylesheet).not.toMatch(
      /\.agent-table-actions \.agent-action-delete\s*\{[^}]*background:\s*var\(--danger\)/s,
    );
    expect(stylesheet).not.toContain(".limits-rule-delete-button");
    // The confirm dialog keeps the loud filled danger button.
    expect(stylesheet).toMatch(/\.agent-delete-confirm\s*\{[^}]*var\(--danger\)/s);
  });

  test("limits rows expose edit without a delete action", () => {
    const source = sectionSource("limits-section.tsx");
    const limitsSection = source.slice(
      source.indexOf("export async function LimitsSection"),
      source.length,
    );
    expect(limitsSection).toContain("aria-label={`Edit ");
    expect(source).not.toContain("function LimitsDeleteDialog");
    expect(source).not.toContain("limitDelete");
    expect(source).not.toContain("aria-label={`Delete ");
  });
});
