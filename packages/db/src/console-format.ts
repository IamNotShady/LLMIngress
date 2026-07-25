// The money rule, shared by everything that reads a stored cost: the console's
// pages and the usage summaries the database layer formats on their behalf.
// Counts and timestamps belong to the console's own display vocabulary.

const MISSING_VALUE = "—";

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

