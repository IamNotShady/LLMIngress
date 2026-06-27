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

type CoveredRange = {
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

    const coveredBytes = mergeCoveredRanges(entry, totalBytes).reduce(
      (total, range) => total + range.end - range.start,
      0,
    );

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

function mergeCoveredRanges(entry: JsCoverageEntry, totalBytes: number): CoveredRange[] {
  const ranges = entry.functions
    .flatMap((fn) => fn.ranges)
    .filter((range) => range.count > 0)
    .map((range) => ({
      end: Math.min(totalBytes, range.endOffset),
      start: Math.max(0, range.startOffset),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const merged: CoveredRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
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
