import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { consoleNavItems } from "../../apps/console/src/app/_lib/nav";

const root = resolve(import.meta.dirname, "../..");

describe("feat-120 E2E frontend coverage command", () => {
  it("wires a Console frontend coverage command and derives pages from navigation", async () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = readFileSync(resolve(root, "scripts/console-e2e-coverage.ts"), "utf8");
    const coverage = await import("../../scripts/console-e2e-coverage");

    expect(packageJson.scripts["test:e2e:coverage"]).toBe(
      "tsx scripts/run-with-env.ts tsx scripts/console-e2e-coverage.ts",
    );
    expect(script).toContain("startJSCoverage({ resetOnNavigation: false })");
    expect(script).toContain("consoleNavItems.map");
    expect(coverage.buildCoveragePages()).toEqual(
      consoleNavItems.map((item) => ({
        heading: item.pageTitle ?? item.label,
        href: item.href,
        label: item.label,
      })),
    );
  });

  it("formats page and JavaScript byte coverage", async () => {
    const coverage = await import("../../scripts/console-e2e-coverage");
    const summary = coverage.summarizeJsCoverage([
      {
        functions: [
          {
            functionName: "covered",
            isBlockCoverage: true,
            ranges: [{ count: 1, endOffset: 4, startOffset: 0 }],
          },
          {
            functionName: "unused",
            isBlockCoverage: true,
            ranges: [{ count: 0, endOffset: 8, startOffset: 4 }],
          },
        ],
        scriptId: "1",
        source: "abcdefgh",
        url: "http://localhost/_next/static/chunks/example.js",
      },
    ]);

    expect(
      coverage.formatCoverageReport({ pages: coverage.buildCoveragePages(), summary }),
    ).toContain(`Visited pages: ${consoleNavItems.length}/${consoleNavItems.length} (100.00%)`);
    expect(
      coverage.formatCoverageReport({ pages: coverage.buildCoveragePages(), summary }),
    ).toContain("JavaScript bytes: 4/8 (50.00%)");
  });

  it("excludes nested uncovered blocks inside an executed function", async () => {
    const coverage = await import("../../scripts/console-e2e-coverage");
    // V8 block coverage nests an unexecuted branch (count 0) inside the
    // function's own executed range (count 1). Only the bytes outside the
    // nested count-0 block are actually covered: [0,4) of an 8-byte source.
    const summary = coverage.summarizeJsCoverage([
      {
        functions: [
          {
            functionName: "withBranch",
            isBlockCoverage: true,
            ranges: [
              { count: 1, endOffset: 8, startOffset: 0 },
              { count: 0, endOffset: 8, startOffset: 4 },
            ],
          },
        ],
        scriptId: "1",
        source: "abcdefgh",
        url: "http://localhost/_next/static/chunks/example.js",
      },
    ]);

    expect(summary.coveredScriptBytes).toBe(4);
    expect(summary.totalScriptBytes).toBe(8);
    expect(summary.percent).toBeCloseTo(50, 5);
  });
});
