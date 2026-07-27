import type {
  ConsoleApiKeyLimit,
  ConsoleBudgetPeriod,
} from "@llmingress/db/console-api-key-limits";

/**
 * A key's rules condensed for display. Three states have to stay distinguishable:
 * rules that enforce, rules that are kept but switched off, and no rules at all —
 * the last of which means the key runs unlimited.
 */
export type ApiKeyLimitsView = {
  budgetLimit: number | null;
  budgetPeriod: string | null;
  concurrency: number | null;
  enforcement: "block" | "warn_only";
  /** The three states the Limits column has: "on · block" / "on · warn" / "off". */
  label: string;
  rpm: number | null;
  spentRatio: number | null;
  spentUsd: string | null;
  state: "disabled" | "enabled" | "none";
  tokensPerRequest: number | null;
  tpm: number | null;
};

export function buildApiKeyLimitsView(input: {
  budgetPeriod: ConsoleBudgetPeriod | undefined;
  limits: ConsoleApiKeyLimit[];
  limitsEnabled: boolean;
}): ApiKeyLimitsView {
  const byType = new Map(input.limits.map((limit) => [limit.limitType, limit]));
  const budget = byType.get("budget");
  const enforcement = budget?.enforcementPolicy ?? input.limits[0]?.enforcementPolicy ?? "block";
  const budgetLimit = budget?.limitValue ?? null;
  // No period row means the gateway has not charged this window yet, which is
  // zero spent — not an unknown amount.
  const spentUsd = input.budgetPeriod?.costUsedUsd ?? (budget ? "0" : null);
  const spent = spentUsd === null ? null : Number.parseFloat(spentUsd);

  const state: ApiKeyLimitsView["state"] =
    input.limits.length === 0 ? "none" : input.limitsEnabled ? "enabled" : "disabled";

  return {
    budgetLimit,
    budgetPeriod: budget?.period ?? null,
    concurrency: byType.get("concurrency")?.limitValue ?? null,
    enforcement,
    // A key with no rules is off, the same as one whose rules are switched
    // off: what is enforced is nothing either way. Which of the two it is
    // belongs in the budget cell, where the rules themselves are described.
    label: state !== "enabled" ? "off" : enforcement === "warn_only" ? "on · warn" : "on · block",
    rpm: byType.get("rpm")?.limitValue ?? null,
    spentRatio:
      budgetLimit && spent !== null && budgetLimit > 0 ? Math.min(1, spent / budgetLimit) : null,
    spentUsd,
    state,
    tokensPerRequest: byType.get("token")?.limitValue ?? null,
    tpm: byType.get("tpm")?.limitValue ?? null,
  };
}

/**
 * The key's rules in one line, spelled out. The one-time creation screen and
 * the key's detail both state what was configured, and they have to say it the
 * same way — the detail is where an operator checks what they handed over.
 */
export function formatApiKeyLimitRules(limits: readonly ConsoleApiKeyLimit[]): string {
  if (limits.length === 0) {
    return "no rules — unlimited";
  }
  return limits
    .map((limit) =>
      limit.limitType === "budget"
        ? `$${limit.limitValue} ${limit.period}`
        : `${limit.limitValue} ${limit.limitType}`,
    )
    .join(" · ");
}

/**
 * What a limit field starts with. An empty box means unlimited, so a ceiling a
 * key does not have must render empty rather than be re-filled from a
 * suggestion — otherwise saving the form quietly re-imposes it. New keys start
 * from the suggested value; existing ones start from what they have.
 */
export function limitFieldValue(value: number | null, suggestion: number | null): string {
  if (value !== null) {
    return String(value);
  }
  return suggestion === null ? "" : String(suggestion);
}

/** Unset ceilings are unlimited, which is not the same as zero. */
export function formatLimitValue(value: number | null): string {
  return value === null ? "unlimited" : value.toLocaleString("en-US");
}

export const ENFORCEMENT_NOTE = "block rejects · warn_only records and passes";

/**
 * Stored as day/week/month, said the way an operator says it. One list, because
 * the key's dialog and the Limits drawer set the same column and would read as
 * two different settings if they named the periods differently.
 */
export const BUDGET_PERIOD_OPTIONS = [
  { label: "monthly", value: "month" },
  { label: "weekly", value: "week" },
  { label: "daily", value: "day" },
] as const;
