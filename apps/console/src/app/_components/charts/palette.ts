// Chart colors expressed as design-system CSS variables so charts track the
// active light/dark theme. recharts accepts any CSS color string, including
// var(--token), for fill/stroke.
export const chartAccent = "var(--accent)";
export const chartOk = "var(--ok)";
export const chartWarn = "var(--warn)";
export const chartDanger = "var(--danger)";

// Ordered categorical palette for breakdown donuts (cycled when exhausted).
export const chartCategorical = [
  "var(--accent)",
  "var(--ok)",
  "var(--warn)",
  "var(--danger)",
  "color-mix(in oklch, var(--accent) 55%, var(--ok))",
  "color-mix(in oklch, var(--accent) 40%, var(--text-faint))",
];

export function categoricalColor(index: number): string {
  return chartCategorical[index % chartCategorical.length] ?? chartAccent;
}
