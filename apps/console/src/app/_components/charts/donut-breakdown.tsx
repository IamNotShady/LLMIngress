"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { categoricalColor } from "./palette";

export type DonutSlice = {
  name: string;
  value: number;
  /** Optional explicit color; falls back to the categorical palette. */
  color?: string;
};

// Donut breakdown used across Overview / Usage / Virtual Models. Renders the
// ring plus a side legend with per-slice values.
export function DonutBreakdown({
  data,
  height = 180,
  ariaLabel,
  valueFormatter = (value) => String(value),
}: {
  data: DonutSlice[];
  height?: number;
  ariaLabel?: string;
  valueFormatter?: (value: number) => string;
}) {
  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  const colored = data.map((slice, index) => ({
    ...slice,
    color: slice.color ?? categoricalColor(index),
  }));

  return (
    <div className="donut" role="img" aria-label={ariaLabel}>
      <div className="donut-ring" style={{ height }}>
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={colored}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={1.5}
              stroke="var(--surface)"
              strokeWidth={2}
            >
              {colored.map((slice) => (
                <Cell key={slice.name} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--text)",
              }}
              formatter={(value, name) => [valueFormatter(Number(value)), String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="donut-legend">
        {colored.map((slice) => {
          const share = total > 0 ? Math.round((slice.value / total) * 100) : 0;
          return (
            <li key={slice.name}>
              <span className="donut-legend-dot" style={{ background: slice.color }} aria-hidden />
              <span className="donut-legend-name">{slice.name}</span>
              <span className="donut-legend-value">{share}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
