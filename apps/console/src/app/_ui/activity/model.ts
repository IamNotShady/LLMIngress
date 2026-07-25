// Activity records request metadata only. Prompts, successful responses, tool
// arguments and credentials never enter the operational log, so nothing on this
// page can reveal message content.

export const ACTIVITY_WINDOWS = {
  "1h": { label: "Last 1h", ms: 60 * 60 * 1000 },
  "24h": { label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
} as const;

export type ActivityWindow = keyof typeof ACTIVITY_WINDOWS;

export function readActivityWindow(value: string | undefined): ActivityWindow {
  return value === "1h" || value === "7d" ? value : "24h";
}

export function activityStatusTone(status: string): string {
  if (status === "failed") {
    return "text-redtx";
  }
  if (status === "succeeded") {
    return "text-green";
  }
  return "text-dim";
}

/** A fallback attempt's own outcome, which is not the request's outcome. */
export function attemptTone(status: string): "amber" | "dim" | "green" | "red" {
  if (status === "succeeded") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  // 'skipped' — the candidate was never tried, e.g. its plan quota was spent.
  return "dim";
}
