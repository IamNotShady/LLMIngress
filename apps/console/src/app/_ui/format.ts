// Presentation helpers shared by every module. Anything that turns a stored
// value into display text lives here so two pages never disagree about what a
// price, a plan cost or a timestamp reads like.

export function formatClock(value: Date | null | undefined): string {
  if (!value) {
    return "—";
  }
  return value.toISOString().slice(11, 16);
}

export function formatStamp(value: Date | null | undefined): string {
  if (!value) {
    return "—";
  }
  return `${value.toISOString().slice(0, 10)} ${value.toISOString().slice(11, 19)} UTC`;
}

export function formatDateOnly(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}

/** "4m ago" / "3h ago" / "6d ago" — relative to now, never a bare timestamp. */
export function formatRelative(value: Date | null | undefined, now: Date = new Date()): string {
  if (!value) {
    return "never";
  }
  const seconds = Math.max(0, Math.round((now.getTime() - value.getTime()) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** 48.2M / 1.6M / 940k / 512 — the compact form the KPI rows use. */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

/**
 * Subscription plans are not metered, so their requests carry no cost at all.
 * A zero there means "plan", not "free" — the two must not look alike.
 */
export function formatCost(
  value: string | number | null | undefined,
  options: { metered?: boolean } = {},
): string {
  if (options.metered === false) {
    return "plan";
  }
  if (value === null || value === undefined) {
    return "—";
  }
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (!Number.isFinite(amount)) {
    return "—";
  }
  if (amount === 0) {
    return "$0.00";
  }
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

export function formatPricePerMillion(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

/** "$3.00 / $15.00 per M" or "subscription plan" for unmetered candidates. */
export function formatPricePair(input: {
  inputUsdPerMillionTokens: number | null;
  metered: boolean;
  outputUsdPerMillionTokens: number | null;
}): string {
  if (!input.metered) {
    return "subscription plan";
  }
  if (input.inputUsdPerMillionTokens === null && input.outputUsdPerMillionTokens === null) {
    return "price unknown";
  }
  return `${formatPricePerMillion(input.inputUsdPerMillionTokens)} / ${formatPricePerMillion(
    input.outputUsdPerMillionTokens,
  )} per M`;
}

export function formatContextWindow(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "—";
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Signed period-over-period delta, e.g. "+8.2% ↑". */
export function formatDelta(
  current: number,
  previous: number,
): { text: string; up: boolean } | null {
  if (previous === 0) {
    return null;
  }
  const ratio = (current - previous) / previous;
  const up = ratio >= 0;
  return { text: `${up ? "+" : ""}${(ratio * 100).toFixed(1)}% ${up ? "↑" : "↓"}`, up };
}

export function formatCapabilities(input: {
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  supportsStreaming: boolean;
}): string {
  const parts: string[] = [];
  if (input.supportsStreaming) {
    parts.push("stream");
  }
  if (input.supportsFunctionCalling) {
    parts.push("tools");
  }
  if (input.supportsReasoning) {
    parts.push("reasoning");
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Offsets in the Activity route timeline read as +114ms from request start. */
export function formatOffset(startedAt: Date, at: Date): string {
  return `+${Math.max(0, at.getTime() - startedAt.getTime())}ms`;
}
