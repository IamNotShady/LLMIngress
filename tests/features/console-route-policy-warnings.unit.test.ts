import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildRoutePolicyHealthWarnings } from "../../packages/db/src/console-route-policies";

const rootDir = process.cwd();
const routePolicies = () =>
  readFileSync(join(rootDir, "packages/db/src/console-route-policies.ts"), "utf8");
const sections = () =>
  readFileSync(join(rootDir, "apps/console/src/app/_modules/sections.tsx"), "utf8");

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  expect(start, `source contains ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `source contains ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("console route policy warnings", () => {
  test("route policy health warnings do not consume stale health flags", () => {
    const warningFunction = sliceBetween(
      routePolicies(),
      "export function buildRoutePolicyHealthWarnings",
      "export function normalizeRoutePolicyEditorFilters",
    );
    const warningCandidates = sliceBetween(
      sections(),
      "function buildRoutePolicyHealthWarningCandidates",
      "function groupProviderKeysByProviderId",
    );

    expect(warningFunction).not.toContain("stale");
    expect(warningCandidates).not.toContain("HealthIsStale");
  });

  test("healthy route candidate statuses do not create route warnings", () => {
    const warnings = buildRoutePolicyHealthWarnings([
      {
        modelHealthStatus: "healthy",
        optionLabel: "OpenAI - gpt-4 (gpt-4)",
        providerHealthStatus: "healthy",
      },
    ]);

    expect(warnings).toEqual([]);
  });

  test("non-healthy route candidate statuses still create route warnings", () => {
    const warnings = buildRoutePolicyHealthWarnings([
      {
        modelHealthStatus: "network_error",
        optionLabel: "Anthropic - claude (claude)",
        providerHealthStatus: "quota_limited",
      },
    ]);

    expect(warnings).toEqual([
      "Health warning: Anthropic - claude (claude) provider health is Quota limited.",
      "Health warning: Anthropic - claude (claude) model health is Network error.",
    ]);
  });

  test("virtual model detail candidate badge labels availability, not health", () => {
    const viewDialog = sliceBetween(
      sections(),
      "function VirtualModelViewDialog",
      "function VirtualModelRouteDialog",
    );

    expect(viewDialog).toContain('<span className="pill--ok pill">Available</span>');
    expect(viewDialog).not.toContain('<span className="pill--ok pill">Healthy</span>');
  });
});
