import type { ConsoleProviderQuotaSummary } from "@llmingress/db/console-provider-quota";
import {
  type BalanceEntry,
  isBalanceEntry,
  isWindowEntry,
  type ProviderQuotaErrorCode,
} from "@llmingress/domain/quota";
import { formatRelativeDateTime } from "./provider-relative-time";

export const QUOTA_NO_LIMITS_LABEL = "No quota limits reported";
export const QUOTA_NOT_QUERIED_LABEL = "Not yet queried";
export const QUOTA_PROBING_PAUSED_LABEL = "Probing paused";
export const QUOTA_SHARED_BALANCE_NOTE = "Shared account balance";

export type ProviderQuotaWindowView = {
  label: string;
  percent: string;
  resetLabel: string | null;
};

export type ProviderQuotaConnectionView = {
  balances: string[];
  // Set when a probe succeeded but reported nothing (openrouter with no
  // spending limit configured is the main case), so the cell is never blank.
  emptyLabel: string | null;
  observedLabel: string | null;
  pausedLabel: string | null;
  reason: string | null;
  sharedBalanceNote: string | null;
  // "expected" covers the states a Provider is documented not to report; they
  // are not failures and must not be styled as such.
  tone: "expected" | "neutral" | "warn";
  windows: ProviderQuotaWindowView[];
};

export type SharedProviderBalance = {
  connectionCount: number;
  key: string;
  label: string;
};

export function formatQuotaUtilization(utilization: number): string {
  if (!Number.isFinite(utilization) || utilization <= 0) {
    return "0%";
  }
  // A live but tiny window must not round down to a flat zero.
  if (utilization < 0.005) {
    return "<1%";
  }
  return `${Math.round(utilization * 100)}%`;
}

export function formatQuotaBalance(entry: BalanceEntry): string {
  // The amount stays the stored decimal string; parsing it to a number would
  // lose the precision the string representation exists to protect.
  return `${entry.total} ${entry.currency}`;
}

export function formatQuotaWindowLabel(window: string): string {
  // Deliberately not an allowlist: upstream adds windows over time and an
  // unknown name must still render.
  const spaced = window.replaceAll("_", " ").trim();
  if (!spaced) {
    return "Window";
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatQuotaReset(
  resetsAt: string | undefined,
  referenceTimeMs: number,
): string | null {
  if (!resetsAt) {
    return null;
  }
  const resetsAtMs = Date.parse(resetsAt);
  if (Number.isNaN(resetsAtMs)) {
    return null;
  }
  const remainingMs = resetsAtMs - referenceTimeMs;
  if (remainingMs <= 0) {
    return "resets now";
  }
  if (remainingMs < 3_600_000) {
    return `resets in ${Math.max(1, Math.floor(remainingMs / 60_000))} min`;
  }
  if (remainingMs < 86_400_000) {
    return `resets in ${Math.floor(remainingMs / 3_600_000)} h`;
  }
  return `resets ${new Date(resetsAtMs).toISOString().slice(0, 10)}`;
}

export function readQuotaErrorReason(errorCode: ProviderQuotaErrorCode): string {
  if (errorCode === "not_supported") {
    return "Not reported by this provider";
  }
  if (errorCode === "requires_separate_credential") {
    return "Needs a separate credential";
  }
  if (errorCode === "unauthorized") {
    return "Credential cannot read quota";
  }
  return "Quota check did not complete";
}

export function isExpectedQuotaState(errorCode: ProviderQuotaErrorCode): boolean {
  return errorCode === "not_supported" || errorCode === "requires_separate_credential";
}

export function quotaBalanceKey(entry: BalanceEntry): string {
  return `${entry.currency}\u0000${entry.total}`;
}

/**
 * Balance is usually account-scoped, so several connections of one Provider
 * reporting the identical amount describe one pool, not N of them.
 */
export function findSharedProviderBalances(
  summaries: readonly ConsoleProviderQuotaSummary[],
): SharedProviderBalance[] {
  const connectionIdsByKey = new Map<string, { entry: BalanceEntry; ids: Set<string> }>();
  for (const summary of summaries) {
    // A paused connection's entries are stale and never rendered; letting them
    // anchor a shared pool would resurrect them at the Provider level.
    if (!summary.probingEnabled) {
      continue;
    }
    for (const entry of summary.entries) {
      if (!isBalanceEntry(entry)) {
        continue;
      }
      const key = quotaBalanceKey(entry);
      const group = connectionIdsByKey.get(key) ?? { entry, ids: new Set<string>() };
      group.ids.add(summary.id);
      connectionIdsByKey.set(key, group);
    }
  }
  return [...connectionIdsByKey.entries()]
    .filter(([, group]) => group.ids.size > 1)
    .map(([key, group]) => ({
      connectionCount: group.ids.size,
      key,
      label: formatQuotaBalance(group.entry),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function buildProviderQuotaConnectionView({
  referenceTimeMs,
  sharedBalanceKeys,
  summary,
}: {
  referenceTimeMs: number;
  sharedBalanceKeys: ReadonlySet<string>;
  summary: ConsoleProviderQuotaSummary | undefined;
}): ProviderQuotaConnectionView {
  // Local Providers have no billing and the enqueue scan never enumerates
  // them, so "Not yet queried" would be a promise that never resolves; the
  // cell states the fact instead. This also outranks the paused branch —
  // pausing is about probing, which never applies to local.
  if (summary?.connectionKind === "local") {
    return {
      balances: [],
      emptyLabel: null,
      observedLabel: null,
      pausedLabel: null,
      reason: readQuotaErrorReason("not_supported"),
      sharedBalanceNote: null,
      tone: "expected",
      windows: [],
    };
  }
  // The enqueue scan skips a disabled or probing-off connection, so whatever
  // its row holds only ages; stale numbers and last-attempt reasons would
  // mislead, and the cell reports the pause instead.
  if (summary && !summary.probingEnabled) {
    return {
      balances: [],
      emptyLabel: null,
      observedLabel: null,
      pausedLabel: QUOTA_PROBING_PAUSED_LABEL,
      reason: null,
      sharedBalanceNote: null,
      tone: "neutral",
      windows: [],
    };
  }
  const entries = summary?.entries ?? [];
  const errorCode = summary?.errorCode ?? null;
  const windows = entries.filter(isWindowEntry).map((entry) => ({
    label: formatQuotaWindowLabel(entry.window),
    percent: formatQuotaUtilization(entry.utilization),
    resetLabel: formatQuotaReset(entry.resetsAt, referenceTimeMs),
  }));
  const balanceEntries = entries.filter(isBalanceEntry);
  const shownBalances = balanceEntries.filter(
    (entry) => !sharedBalanceKeys.has(quotaBalanceKey(entry)),
  );
  const hasSharedBalance = shownBalances.length < balanceEntries.length;
  const observedAt = summary?.observedAt ?? null;

  return {
    balances: shownBalances.map(formatQuotaBalance),
    emptyLabel: entries.length === 0 && !errorCode && observedAt ? QUOTA_NO_LIMITS_LABEL : null,
    // Staleness only matters for real quota numbers: an error state renders its
    // reason pill alone, without a competing "Updated X ago" line.
    observedLabel: errorCode
      ? null
      : observedAt
        ? `Updated ${formatRelativeDateTime(observedAt, referenceTimeMs)}`
        : QUOTA_NOT_QUERIED_LABEL,
    pausedLabel: null,
    reason: errorCode ? readQuotaErrorReason(errorCode) : null,
    sharedBalanceNote: hasSharedBalance ? QUOTA_SHARED_BALANCE_NOTE : null,
    tone: errorCode ? (isExpectedQuotaState(errorCode) ? "expected" : "warn") : "neutral",
    windows,
  };
}
