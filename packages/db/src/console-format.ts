// Shared console display vocabulary. Every page formats the same kind of
// value the same way: full locale counts in tables, compact counts only in
// KPI cards, one smart-precision USD rule, an em dash for missing values, and
// date-qualified timestamps outside the current day.

export const MISSING_VALUE = "—";

export function formatConsoleCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return MISSING_VALUE;
  }
  return value.toLocaleString("en-US");
}

export function formatConsoleCompactCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return MISSING_VALUE;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

// Two decimals at or above one cent, three significant digits below it —
// "$0.0000843" carries the information "$0.00008428" pretended to.
export function formatConsoleUsd(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return MISSING_VALUE;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return MISSING_VALUE;
  }
  if (numeric === 0) {
    return "$0.00";
  }
  if (Math.abs(numeric) >= 0.01) {
    return `$${numeric.toFixed(2)}`;
  }
  return `$${numeric.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

export function formatConsoleTimestamp(value: Date, now: Date = new Date()): string {
  const time = value.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const sameDay =
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate();
  if (sameDay) {
    return time;
  }
  const monthDay = value.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const datePart =
    value.getFullYear() === now.getFullYear() ? monthDay : `${monthDay}, ${value.getFullYear()}`;
  return `${datePart} ${time}`;
}
