// Chart colors expressed as design-system CSS variables so charts track the
// console skin. recharts accepts any CSS color string, including var(--token).
export const chartAccent = "var(--chart-1)";
export const chartOk = "var(--ok)";
export const chartWarn = "var(--warn)";
export const chartDanger = "var(--danger)";

// Ordered categorical palette for breakdown donuts (cycled when exhausted).
export const chartCategorical = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export function categoricalColor(index: number): string {
  return chartCategorical[index % chartCategorical.length] ?? chartAccent;
}
