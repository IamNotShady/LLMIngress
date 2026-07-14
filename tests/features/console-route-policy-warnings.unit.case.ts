import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildRoutePolicyConnectionHealthWarnings } from "../../packages/db/src/console-route-policies";

const rootDir = process.cwd();
const routePolicies = () =>
  readFileSync(join(rootDir, "packages/db/src/console-route-policies.ts"), "utf8");
const sections = () =>
  readFileSync(join(rootDir, "apps/console/src/app/_modules/sections.tsx"), "utf8");
const virtualModelsSection = () =>
  readFileSync(join(rootDir, "apps/console/src/app/_modules/virtual-models-section.tsx"), "utf8");

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  expect(start, `source contains ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `source contains ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("console route policy warnings", () => {
  test("route policy connection health warnings do not consume stale health flags", () => {
    const warningFunction = sliceBetween(
      routePolicies(),
      "export function buildRoutePolicyConnectionHealthWarnings",
      "export function normalizeRoutePolicyEditorFilters",
    );
    const warningCandidates = sliceBetween(
      sections(),
      "function buildRoutePolicyConnectionHealthWarningCandidates",
      "function orderProviderModelsForConsole",
    );

    expect(warningFunction).not.toContain("stale");
    expect(warningCandidates).not.toContain("HealthIsStale");
  });

  test("a route with an available connection does not create a health warning", () => {
    const warnings = buildRoutePolicyConnectionHealthWarnings([
      {
        allConnectionsUnhealthy: false,
        optionLabel: "OpenAI - gpt-4 (gpt-4)",
      },
    ]);

    expect(warnings).toEqual([]);
  });

  test("a route with no healthy connections creates one connection warning", () => {
    const warnings = buildRoutePolicyConnectionHealthWarnings([
      {
        allConnectionsUnhealthy: true,
        optionLabel: "Anthropic - claude (claude)",
      },
    ]);

    expect(warnings).toEqual([
      "Health warning: Anthropic - claude (claude) has no healthy Provider connections.",
    ]);
  });

  test("virtual model detail candidate badge labels availability, not health", () => {
    const viewDialog = sliceBetween(
      virtualModelsSection(),
      "function VirtualModelViewDialog",
      "function VirtualModelRouteDialog",
    );

    expect(viewDialog).toContain('<span className="pill--ok pill">Available</span>');
    expect(viewDialog).not.toContain('<span className="pill--ok pill">Healthy</span>');
  });
});
