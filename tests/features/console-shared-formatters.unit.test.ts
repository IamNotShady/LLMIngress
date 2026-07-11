import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  formatConsoleCompactCount,
  formatConsoleCount,
  formatConsoleTimestamp,
  formatConsoleUsd,
  MISSING_VALUE,
} from "../../packages/db/src/console-format";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const moduleSource = (file: string) => readFileSync(join(appDir, "_modules", file), "utf8");
const consoleSectionSource = () =>
  [
    "sections.tsx",
    "overview-section.tsx",
    "usage-section.tsx",
    "activity-section.tsx",
    "virtual-models-section.tsx",
    "route-policies-section.tsx",
    "agents-section.tsx",
    "limits-section.tsx",
    "models-section.tsx",
    "providers-section.tsx",
  ]
    .map(moduleSource)
    .join("\n");

describe("shared console formatters", () => {
  test("USD uses smart precision: cents at 2 decimals, sub-cent at 3 significant digits", () => {
    expect(formatConsoleUsd(null)).toBe(MISSING_VALUE);
    expect(formatConsoleUsd(Number.NaN)).toBe(MISSING_VALUE);
    expect(formatConsoleUsd("not-a-number")).toBe(MISSING_VALUE);
    expect(formatConsoleUsd(0)).toBe("$0.00");
    expect(formatConsoleUsd("0.00000000")).toBe("$0.00");
    expect(formatConsoleUsd(12.345)).toBe("$12.35");
    expect(formatConsoleUsd("0.13614875")).toBe("$0.14");
    expect(formatConsoleUsd(0.00008428)).toBe("$0.0000843");
    expect(formatConsoleUsd("0.00730840")).toBe("$0.00731");
  });

  test("counts are full locale numbers; compact only for KPI cards", () => {
    expect(formatConsoleCount(null)).toBe(MISSING_VALUE);
    expect(formatConsoleCount(92535)).toBe("92,535");
    expect(formatConsoleCount(0)).toBe("0");
    expect(formatConsoleCompactCount(92535)).toBe("92.5K");
    expect(formatConsoleCompactCount(1_250_000)).toBe("1.3M");
    expect(formatConsoleCompactCount(999)).toBe("999");
    expect(formatConsoleCompactCount(null)).toBe(MISSING_VALUE);
  });

  test("timestamps outside the current day carry a date qualifier", () => {
    const now = new Date("2026-07-03T22:00:00");
    expect(formatConsoleTimestamp(new Date("2026-07-03T21:48:19"), now)).toBe("21:48:19");
    expect(formatConsoleTimestamp(new Date("2026-06-26T21:48:19"), now)).toBe("Jun 26 21:48:19");
    expect(formatConsoleTimestamp(new Date("2025-12-31T09:05:00"), now)).toBe(
      "Dec 31, 2025 09:05:00",
    );
  });
});

describe("console pages consume the shared formatters", () => {
  test("console section modules import the shared module and drop local look-alikes", () => {
    const source = consoleSectionSource();
    expect(source).toContain('from "@llmingress/db/console-format"');
    for (const orphan of [
      "function formatCompactNumber",
      "function formatFullNumber",
      "function formatActivityTableTokens",
      "function formatActivityTableCost",
      "function formatOverviewMoney",
      "function formatOverviewActivityCost",
      "function formatTime",
    ]) {
      expect(source, `${orphan} should be replaced by the shared module`).not.toContain(orphan);
    }
    // The old null vocabulary is gone from data cells.
    expect(source).not.toContain('"N/A"');
    expect(source).not.toContain('? "Unavailable" :');
  });

  test("db display formatters delegate to the shared USD rule", () => {
    const usage = readFileSync(join(rootDir, "packages/db/src/console-usage.ts"), "utf8");
    const activity = readFileSync(join(rootDir, "packages/db/src/console-activity.ts"), "utf8");
    expect(usage).toContain("formatConsoleUsd(");
    expect(activity).toContain("formatConsoleUsd(");
    expect(usage).not.toContain("toFixed(8)");
    expect(activity).not.toContain("toFixed(8)");
  });
});
