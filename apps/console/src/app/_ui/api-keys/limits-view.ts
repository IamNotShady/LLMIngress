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
  /** "on · block" / "on · warn" / "off" / "no rules". */
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
    label:
      state === "none"
        ? "no rules"
        : state === "disabled"
          ? "off"
          : enforcement === "warn_only"
            ? "on · warn"
            : "on · block",
    rpm: byType.get("rpm")?.limitValue ?? null,
    spentRatio:
      budgetLimit && spent !== null && budgetLimit > 0 ? Math.min(1, spent / budgetLimit) : null,
    spentUsd,
    state,
    tokensPerRequest: byType.get("token")?.limitValue ?? null,
    tpm: byType.get("tpm")?.limitValue ?? null,
  };
}

/** Unset ceilings are unlimited, which is not the same as zero. */
export function formatLimitValue(value: number | null): string {
  return value === null ? "unlimited" : value.toLocaleString("en-US");
}

export const ENFORCEMENT_NOTE =
  "block rejects the request · warn_only records the breach and lets it through";
