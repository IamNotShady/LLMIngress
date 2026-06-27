import { pathToFileURL } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import {
  type ConsoleNavItem,
  consoleNavItems,
} from "../apps/console/src/app/_lib/nav";
import { withConsoleDevServer } from "../tests/support/console-dev-server";

export type CoveragePage = {
  heading: string;
  href: string;
  label: string;
};

export type JsCoverageEntry = Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>[number];

export type JsCoverageSummary = {
  coveredScriptBytes: number;
  totalScriptBytes: number;
  coveredScriptCount: number;
  totalScriptCount: number;
  percent: number;
};

export type CoverageReport = {
  pages: CoveragePage[];
  summary: JsCoverageSummary;
};

type CountedRange = {
  count: number;
  end: number;
  start: number;
};

export function buildCoveragePages(items: ConsoleNavItem[] = consoleNavItems): CoveragePage[] {
  if (items === consoleNavItems) {
    return consoleNavItems.map(toCoveragePage);
  }
  return items.map(toCoveragePage);
}

export function summarizeJsCoverage(entries: JsCoverageEntry[]): JsCoverageSummary {
  let coveredScriptBytes = 0;
  let totalScriptBytes = 0;
  let coveredScriptCount = 0;
  let totalScriptCount = 0;

  for (const entry of entries) {
    const totalBytes = entry.source?.length ?? 0;
    if (totalBytes === 0) {
      continue;
    }

    const coveredBytes = countCoveredBytes(entry, totalBytes);

    totalScriptBytes += totalBytes;
    totalScriptCount += 1;

    if (coveredBytes > 0) {
      coveredScriptBytes += coveredBytes;
      coveredScriptCount += 1;
    }
  }

  return {
    coveredScriptBytes,
    coveredScriptCount,
    percent: percent(coveredScriptBytes, totalScriptBytes),
    totalScriptBytes,
    totalScriptCount,
  };
}

export function formatCoverageReport(report: CoverageReport): string {
  const totalPages = buildCoveragePages().length;

  return [
    "Console frontend page coverage",
    `Visited pages: ${report.pages.length}/${totalPages} (${formatPercent(report.pages.length, totalPages)})`,
    `JavaScript bytes: ${report.summary.coveredScriptBytes}/${report.summary.totalScriptBytes} (${formatPercent(
      report.summary.coveredScriptBytes,
      report.summary.totalScriptBytes,
    )})`,
    `Covered scripts: ${report.summary.coveredScriptCount}/${report.summary.totalScriptCount}`,
    "Pages:",
    ...report.pages.map((page) => `- ${page.label}: ${page.href}`),
  ].join("\n");
}

export async function runConsoleE2eCoverage(): Promise<CoverageReport> {
  const browser = await chromium.launch();
  const pages = buildCoveragePages();
  let coverageEntries: JsCoverageEntry[] = [];

  try {
    await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });

      for (const coveragePage of pages) {
        await page.goto(new URL(coveragePage.href, baseUrl).toString());
        await expect(
          page.getByRole("heading", { exact: true, level: 1, name: coveragePage.heading }),
        ).toBeVisible();
      }

      coverageEntries = await page.coverage.stopJSCoverage();
    });
  } finally {
    await browser.close();
  }

  const summary = summarizeJsCoverage(coverageEntries);
  if (summary.totalScriptBytes === 0) {
    throw new Error("No frontend JavaScript coverage entries were collected.");
  }

  return { pages, summary };
}

function toCoveragePage(item: ConsoleNavItem): CoveragePage {
  return {
    heading: item.pageTitle ?? item.label,
    href: item.href,
    label: item.label,
  };
}

function countCoveredBytes(entry: JsCoverageEntry, totalBytes: number): number {
  const ranges: CountedRange[] = entry.functions
    .flatMap((fn) => fn.ranges)
    .map((range) => ({
      count: range.count,
      end: Math.min(totalBytes, range.endOffset),
      start: Math.max(0, range.startOffset),
    }))
    .filter((range) => range.end > range.start);

  if (ranges.length === 0) {
    return 0;
  }

  // V8 block coverage nests ranges: an unexecuted branch (count 0) sits inside
  // its enclosing function's executed range (count 1). A byte is covered only
  // if the innermost range over it has count > 0, so we walk every elementary
  // segment between range boundaries and resolve the innermost enclosing range.
  const boundaries = Array.from(
    new Set(ranges.flatMap((range) => [range.start, range.end])),
  ).sort((a, b) => a - b);

  let coveredBytes = 0;
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];

    let innermost: CountedRange | undefined;
    for (const range of ranges) {
      if (range.start > start || range.end < end) {
        continue;
      }
      // The innermost enclosing range has the greatest start, breaking ties on
      // the smallest end.
      if (
        !innermost ||
        range.start > innermost.start ||
        (range.start === innermost.start && range.end < innermost.end)
      ) {
        innermost = range;
      }
    }

    if (innermost && innermost.count > 0) {
      coveredBytes += end - start;
    }
  }

  return coveredBytes;
}

function formatPercent(numerator: number, denominator: number): string {
  return `${percent(numerator, denominator).toFixed(2)}%`;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConsoleE2eCoverage()
    .then((report) => {
      console.log(formatCoverageReport(report));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
