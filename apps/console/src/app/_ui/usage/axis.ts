import type { ConsoleUsageTrendPoint, ConsoleUsageWindow } from "@llmingress/db/console-usage";

export function readUsageWindow(value: string | undefined): ConsoleUsageWindow {
  return value === "7d" || value === "30d" ? value : "24h";
}

/**
 * Up to five evenly spaced labels under a chart. Buckets are hourly for 24h and
 * daily beyond it, so the label format follows the bucket, not the window name.
 *
 * Fewer buckets than labels gets one label per bucket: spacing five positions
 * across three buckets lands on the same bucket twice, and the axis then reads
 * as if the same hour happened twice.
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

  const count = Math.min(5, trend.length);
  return Array.from({ length: count }, (_, index) => {
    const position = count === 1 ? 0 : Math.round((index / (count - 1)) * (trend.length - 1));
    return format(trend[position]?.bucketStart ?? now);
  });
}
