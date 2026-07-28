import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildRoutePolicyConnectionHealthWarnings } from "../../packages/db/src/console-route-policies";

const rootDir = process.cwd();
const routePolicies = () =>
  readFileSync(join(rootDir, "packages/db/src/console-route-policies.ts"), "utf8");

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
    expect(warningFunction).not.toContain("stale");
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

  test("the route table separates a candidate's availability from its health", () => {
    const detail = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/detail.tsx"),
      "utf8",
    );

    // Health is the provider connection's; availability is the model's own
    // state. Conflating them would report a deprecated model as unhealthy.
    expect(detail).toContain("describeProviderHealth");
    expect(detail).toContain("HEALTH");
    expect(detail).not.toMatch(/availability[^\n]*healthy/i);
  });
});
