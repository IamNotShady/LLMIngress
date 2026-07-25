import type { ConsoleUsageTrendPoint, ConsoleUsageWindow } from "@llmingress/db/console-usage";
import Link from "next/link";
import { buildHref, type SearchParams } from "../params";

const WINDOWS: ConsoleUsageWindow[] = ["24h", "7d", "30d"];

export function readUsageWindow(value: string | undefined): ConsoleUsageWindow {
  return value === "7d" || value === "30d" ? value : "24h";
}

/** Segmented control; the active segment inverts to the primary fill. */
export function WindowPicker({
  params,
  pathname,
  window,
}: {
  params: SearchParams;
  pathname: string;
  window: ConsoleUsageWindow;
}) {
  return (
    <div className="flex overflow-hidden rounded-sm border border-rule">
      {WINDOWS.map((entry, index) => (
        <Link
          key={entry}
          href={buildHref(pathname, params, { window: entry })}
          className={`px-[11px] py-1 font-mono text-13 ${index > 0 ? "border-l border-rule" : ""} ${
            entry === window ? "bg-seg text-segfg" : "text-dim"
          }`}
        >
          {entry}
        </Link>
      ))}
    </div>
  );
}

/**
 * Five evenly spaced labels under a chart. Buckets are hourly for 24h and daily
 * beyond it, so the label format follows the bucket, not the window name.
 */
export function axisLabelsForWindow(
  window: ConsoleUsageWindow,
  trend: ConsoleUsageTrendPoint[],
  now: Date,
): string[] {
  if (trend.length === 0) {
    return [];
  }
  const format = (date: Date) =>
    window === "24h" ? date.toISOString().slice(11, 16) : date.toISOString().slice(5, 10);

  return Array.from({ length: 5 }, (_, index) => {
    const position = Math.min(trend.length - 1, Math.round((index / 4) * (trend.length - 1)));
    return format(trend[position]?.bucketStart ?? now);
  });
}
