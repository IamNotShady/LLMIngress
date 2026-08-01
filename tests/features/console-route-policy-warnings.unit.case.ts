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

  test("route warnings reach the operator through the Route section", () => {
    const detail = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/detail.tsx"),
      "utf8",
    );

    // The db layer computes routeWarnings on every read; without a render point
    // the soft warnings (price, availability, tag coverage) are invisible.
    expect(detail).toContain("policy.routeWarnings");
    expect(detail).toContain("route-warnings");
  });

  test("the tag route table shows the tags that select each candidate", () => {
    const detail = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/detail.tsx"),
      "utf8",
    );

    expect(detail).toContain("TAGS");
    expect(detail).toContain("candidate.tags");
  });

  test("the route editor collects one tag field per candidate of a tag route", () => {
    const dialogs = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/dialogs.tsx"),
      "utf8",
    );

    // The tag field and the providerModelIds hidden inputs must both be emitted
    // once per selected candidate, or FormData pairs a tag with the wrong model.
    expect(dialogs).toContain('name="candidateTags"');
    expect(dialogs).toContain('<input type="hidden" name="candidateTags" value="" />');
  });

  test("the route editor collects one weight field per candidate of a weighted route", () => {
    const dialogs = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/dialogs.tsx"),
      "utf8",
    );

    // The weight field and the providerModelIds hidden inputs must both be
    // emitted once per selected candidate, or FormData pairs a weight with the
    // wrong model.
    expect(dialogs).toContain('name="candidateWeights"');
    expect(dialogs).toContain('<input type="hidden" name="candidateWeights" value="" />');
  });

  test("the weight field constrains drafts to a two-decimal weight shape while typing", () => {
    const weightInput = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/weight-input.tsx"),
      "utf8",
    );
    const dialogs = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/dialogs.tsx"),
      "utf8",
    );

    expect(weightInput).toContain('"use client"');
    expect(weightInput).toContain("0\\.\\d{0,2}");
    expect(dialogs).toContain("<WeightInput");
  });

  test("the weighted route table shows each candidate's configured weight", () => {
    const detail = readFileSync(
      join(rootDir, "apps/console/src/app/_ui/virtual-models/detail.tsx"),
      "utf8",
    );

    expect(detail).toContain("WEIGHT");
    expect(detail).toContain("candidate.weight");
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
