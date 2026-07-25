import { formatConsoleUsd } from "@llmingress/db/console-format";
import { formatRelativeDateTime } from "./provider-relative-time";

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

/**
 * "just now" / "12 min ago" / "3 h ago", falling back to the date past a day.
 * Delegates to the shared relative formatter so every surface agrees.
 */
export function formatRelative(value: Date | null | undefined, now: Date = new Date()): string {
  if (!value) {
    return "never";
  }
  return formatRelativeDateTime(value, now.getTime());
}

/** "in 6d" / "in 4h" — the mirror of formatRelative for a moment still ahead. */
export function formatUntil(value: Date | null | undefined, now: Date = new Date()): string {
  if (!value) {
    return "—";
  }
  const seconds = Math.max(0, Math.round((value.getTime() - now.getTime()) / 1000));
  if (seconds < 60) {
    return "in under a minute";
  }
  if (seconds < 3600) {
    return `in ${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `in ${Math.floor(seconds / 3600)}h`;
  }
  return `in ${Math.floor(seconds / 86_400)}d`;
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
  // The amount itself follows the shared USD rule — cents at two decimals,
  // sub-cent at three significant digits — so a fraction of a cent never
  // collapses to $0.00 on one page and not another.
  return formatConsoleUsd(value ?? null);
}

export function formatPricePerMillion(value: number | null): string {
  return value === null ? "—" : formatConsoleUsd(value);
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

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "—";
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Signed period-over-period delta, e.g. "+8.2% ↑". The tone is per metric, not
 * per direction: more requests is good, more cost is not, so the caller states
 * which way is good and the colour follows that rather than the arrow.
 */
export function formatDelta(
  current: number,
  previous: number,
  polarity: "down-good" | "up-good" = "up-good",
): { text: string; tone: "bad" | "good" | "neutral" } | null {
  if (previous === 0) {
    return null;
  }
  const ratio = (current - previous) / previous;
  const up = ratio >= 0;
  const tone =
    ratio === 0
      ? "neutral"
      : (up ? polarity === "up-good" : polarity === "down-good")
        ? "good"
        : "bad";
  return { text: `${up ? "+" : ""}${(ratio * 100).toFixed(1)}% ${up ? "↑" : "↓"}`, tone };
}

/**
 * Failure rate crosses into warning at 5% and into danger at 20%. A low but
 * non-zero rate is normal for upstreams and must not be painted as an outage.
 */
export function failureRateTone(rate: number): "danger" | "neutral" | "warn" {
  if (rate >= 0.2) {
    return "danger";
  }
  if (rate >= 0.05) {
    return "warn";
  }
  return "neutral";
}

export const failureRateToneClass: Record<"danger" | "neutral" | "warn", string> = {
  danger: "text-red",
  neutral: "text-ink",
  warn: "text-ambtx",
};

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
