import { formatCompact } from "./format";

// Charts here are plain divs sized by percentage: the console has no chart
// library, the shapes are simple, and a bar that is 40% tall is literally 40%
// of the tallest bucket.

export type ChartSeries = {
  className: string;
  label: string;
  values: number[];
};

/** Stacked column chart. Series stack bottom-up in the order given. */
export function StackedBarChart({
  axisLabels,
  height = 150,
  series,
}: {
  axisLabels: string[];
  height?: number;
  series: ChartSeries[];
}) {
  const bucketCount = series[0]?.values.length ?? 0;
  const totals = Array.from({ length: bucketCount }, (_, index) =>
    series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0),
  );
  const max = Math.max(1, ...totals);

  return (
    <>
      <div className="mt-[14px] flex items-end gap-[3px] border-b border-hair" style={{ height }}>
        {Array.from({ length: bucketCount }, (_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional, not identified
            key={index}
            className="flex h-full flex-1 flex-col justify-end"
            title={`${formatCompact(totals[index] ?? 0)} in this bucket`}
          >
            {[...series].reverse().map((entry) => (
              <div
                key={entry.label}
                className={entry.className}
                style={{ height: `${(((entry.values[index] ?? 0) / max) * 100).toFixed(2)}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-[6px] flex justify-between font-mono text-12 text-faint">
        {axisLabels.map((label, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a label marks a position on the axis, and two positions can read the same
          <span key={index}>{label}</span>
        ))}
      </div>
    </>
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="ml-auto flex gap-[14px]">
      {series.map((entry) => (
        <span
          key={entry.label}
          className="flex items-center gap-[5px] whitespace-nowrap font-mono text-12 text-dim"
        >
          <span className={`size-2 ${entry.className}`} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

/** Segmented single bar, e.g. the token-source split. */
export function SegmentBar({
  segments,
}: {
  segments: Array<{ className: string; label: string; value: number }>;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <>
      <div className="mt-[6px] flex h-[9px] bg-track">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className={segment.className}
            style={{ width: total > 0 ? `${((segment.value / total) * 100).toFixed(2)}%` : "0%" }}
          />
        ))}
      </div>
      <div className="mt-[6px] flex flex-wrap gap-3 font-mono text-12 text-dim">
        {segments.map((segment) => (
          <span key={segment.label}>
            {segment.label} {total > 0 ? `${((segment.value / total) * 100).toFixed(1)}%` : "—"}
          </span>
        ))}
      </div>
    </>
  );
}
