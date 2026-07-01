"use client";

import type { CSSProperties } from "react";
import { categoricalColor } from "./palette";

export type DonutSlice = {
  id?: string;
  name: string;
  value: number;
  /** Optional explicit color; falls back to the categorical palette. */
  color?: string;
};

// Donut breakdown used across Overview / Usage / Virtual Models. Renders the
// ring plus a side legend with per-slice values.
// Value formatting is selected by a serializable string (not a function) so
// this client component can be used from server components.
export type DonutValueFormat = "number" | "usd" | "percent";

function formatDonutValue(value: number, format: DonutValueFormat): string {
  if (format === "usd") {
    if (value > 0 && value < 0.01) {
      return `$${value.toFixed(4)}`;
    }
    return `$${value.toFixed(2)}`;
  }
  if (format === "percent") {
    return `${value}%`;
  }
  return String(value);
}

export function DonutBreakdown({
  data,
  height = 180,
  ariaLabel,
  valueFormat = "number",
}: {
  data: DonutSlice[];
  height?: number;
  ariaLabel?: string;
  valueFormat?: DonutValueFormat;
}) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  const colored = data.map((slice, index) => ({
    ...slice,
    color: slice.color ?? categoricalColor(index),
  }));
  const ringStyle = {
    "--donut-fill": buildDonutGradient(colored, total),
    height,
  } as CSSProperties;

  return (
    <div className="donut" role="img" aria-label={ariaLabel}>
      <div className="donut-ring" style={ringStyle}>
        <span className="donut-ring-graphic" aria-hidden />
      </div>
      <ul className="donut-legend">
        {colored.map((slice, index) => {
          const share = total > 0 ? Math.round((slice.value / total) * 100) : 0;
          return (
            <li key={slice.id ?? `${slice.name}:${index}`}>
              <span className="donut-legend-dot" style={{ background: slice.color }} aria-hidden />
              <span className="donut-legend-name">{slice.name}</span>
              <span className="donut-legend-value">
                {valueFormat === "usd" ? `${formatDonutValue(slice.value, valueFormat)} / ` : null}
                {share}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function buildDonutGradient(data: Array<DonutSlice & { color: string }>, total: number): string {
  if (total <= 0) {
    return "conic-gradient(var(--border) 0turn 1turn)";
  }
  let cursor = 0;
  const segments = data.map((slice) => {
    const start = cursor;
    cursor += slice.value / total;
    return `${slice.color} ${start}turn ${cursor}turn`;
  });
  return `conic-gradient(${segments.join(", ")})`;
}
