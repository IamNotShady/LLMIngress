import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  formatClock,
  formatCompact,
  formatCost,
  formatCount,
  formatStamp,
} from "../../apps/console/src/app/_ui/format";
import { formatConsoleUsd } from "../../packages/db/src/console-format";

const MISSING_VALUE = "—";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

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
    expect(formatCount(92535)).toBe("92,535");
    expect(formatCount(0)).toBe("0");
    expect(formatCompact(92535)).toBe("92.5k");
    expect(formatCompact(1_250_000)).toBe("1.3M");
    expect(formatCompact(999)).toBe("999");
  });

  test("timestamps read in UTC, to the minute in a row and to the second in a detail", () => {
    const at = new Date("2026-07-03T21:48:19Z");
    expect(formatClock(at)).toBe("21:48");
    expect(formatStamp(at)).toBe("2026-07-03 21:48:19 UTC");
    // A missing moment is an em dash, never a zero clock.
    expect(formatClock(null)).toBe(MISSING_VALUE);
    expect(formatStamp(null)).toBe(MISSING_VALUE);
  });
});

describe("console pages consume the shared formatters", () => {
  test("the console money formatter delegates to the shared USD rule", () => {
    // A fraction of a cent must not collapse to $0.00 on one page only.
    expect(formatCost("0.00008428")).toBe(formatConsoleUsd(0.00008428));
    expect(formatCost("0.13614875")).toBe("$0.14");
    expect(formatCost(null)).toBe(MISSING_VALUE);
    // Subscription traffic is unmetered, which is not the same as costing zero.
    expect(formatCost("0", { metered: false })).toBe("plan");
  });

  test("no page grows a local money or count formatter of its own", () => {
    const sources = walk(appDir)
      .filter((path) => /\.tsx?$/.test(path) && !path.endsWith("_ui/format.ts"))
      .map((path) => [path, readFileSync(path, "utf8")] as const);

    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(/function format(Compact|Full)?(Number|Money|Usd)/);
      expect(source, path).not.toContain('"N/A"');
    }
  });

  test("db display formatters delegate to the shared USD rule", () => {
    const usage = readFileSync(join(rootDir, "packages/db/src/console-usage.ts"), "utf8");
    const activity = readFileSync(join(rootDir, "packages/db/src/console-activity.ts"), "utf8");
    expect(usage).toContain("formatConsoleUsd(");
    expect(usage).not.toContain("toFixed(8)");
    expect(activity).not.toContain("toFixed(8)");
  });
});
