import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildProviderQuotaConnectionView,
  findSharedProviderBalances,
  formatQuotaBalance,
  formatQuotaReset,
  formatQuotaUtilization,
  formatQuotaWindowLabel,
  QUOTA_NO_LIMITS_LABEL,
  QUOTA_NOT_QUERIED_LABEL,
  QUOTA_PROBING_PAUSED_LABEL,
  quotaBalanceKey,
  readQuotaErrorReason,
} from "../../apps/console/src/app/_ui/provider-quota-format";
import { isBalanceEntry, isWindowEntry, type QuotaEntry } from "../../packages/domain/src/quota";

const referenceTimeMs = Date.parse("2026-07-20T10:00:00Z");

// A claude_code array carries both shapes at once; nothing in the array says
// which is which, so every consumer discriminates on field presence.
const mixedEntries: QuotaEntry[] = [
  { resetsAt: "2026-07-20T12:00:00Z", utilization: 0.0741, window: "five_hour" },
  { resetsAt: "2026-07-24T03:00:00Z", utilization: 0.5312, window: "seven_day" },
  { currency: "USD", total: "76.50" },
];

function summaryOf(
  overrides: Partial<
    Parameters<typeof buildProviderQuotaConnectionView>[0]["summary"] & object
  > = {},
) {
  return {
    connectionKind: "api_key" as const,
    connectionLabel: "sk-test",
    entries: [] as QuotaEntry[],
    errorCode: null,
    id: "connection-1",
    observedAt: new Date(referenceTimeMs - 3 * 60_000),
    probingEnabled: true,
    providerDisplayName: "Quota Provider",
    quotaProbeEnabled: true,
    providerId: "provider-1",
    providerKey: "deepseek",
    ...overrides,
  };
}

describe("quota entry discrimination", () => {
  it("splits one array into windows and balances by field presence, not a type tag", () => {
    expect(mixedEntries.filter(isWindowEntry)).toEqual([
      { resetsAt: "2026-07-20T12:00:00Z", utilization: 0.0741, window: "five_hour" },
      { resetsAt: "2026-07-24T03:00:00Z", utilization: 0.5312, window: "seven_day" },
    ]);
    expect(mixedEntries.filter(isBalanceEntry)).toEqual([{ currency: "USD", total: "76.50" }]);
    // No entry is claimed by both predicates.
    expect(mixedEntries.filter((entry) => isWindowEntry(entry) && isBalanceEntry(entry))).toEqual(
      [],
    );
  });

  it("renders a connection carrying both shapes as windows plus a balance", () => {
    const view = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ entries: mixedEntries }),
    });
    expect(view.windows).toEqual([
      { label: "Five hour", percent: "7%", resetLabel: "resets in 2 h" },
      { label: "Seven day", percent: "53%", resetLabel: "resets 2026-07-24" },
    ]);
    expect(view.balances).toEqual([{ breakdown: null, label: "76.50 USD" }]);
    expect(view.reason).toBeNull();
  });

  it("says where a balance came from when the provider breaks it down", () => {
    const view = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({
        entries: [{ currency: "USD", granted: "20.00", toppedUp: "30.00", total: "50.00" }],
      }),
    });

    // A total alone does not say whether the credit renews with the plan or was
    // paid for, which is the thing an operator is deciding about.
    expect(view.balances).toEqual([
      { breakdown: "granted 20.00 USD · topped up 30.00 USD", label: "50.00 USD" },
    ]);
  });
});

describe("quota value formatting", () => {
  it("renders utilization as a percentage and never rounds a live window down to zero", () => {
    expect(formatQuotaUtilization(0)).toBe("0%");
    expect(formatQuotaUtilization(0.0741)).toBe("7%");
    expect(formatQuotaUtilization(0.5312)).toBe("53%");
    expect(formatQuotaUtilization(1)).toBe("100%");
    expect(formatQuotaUtilization(0.0004)).toBe("<1%");
  });

  it("renders a balance with its currency and preserves the stored decimal string exactly", () => {
    expect(formatQuotaBalance({ currency: "CNY", total: "110.00" })).toBe("110.00 CNY");
    // Monetary values are decimal strings precisely because IEEE 754 loses digits.
    expect(formatQuotaBalance({ currency: "USD", total: "0.100000000000000005" })).toBe(
      "0.100000000000000005 USD",
    );
  });

  it("labels any window name, including ones added upstream after this code shipped", () => {
    expect(formatQuotaWindowLabel("five_hour")).toBe("Five hour");
    expect(formatQuotaWindowLabel("seven_day_opus")).toBe("Seven day opus");
    expect(formatQuotaWindowLabel("5h")).toBe("5h");
    expect(formatQuotaWindowLabel("some_future_window")).toBe("Some future window");
  });

  it("renders a reset time relative to now, and absolutely once it is days out", () => {
    expect(formatQuotaReset("2026-07-20T10:30:00Z", referenceTimeMs)).toBe("resets in 30 min");
    expect(formatQuotaReset("2026-07-20T14:00:00Z", referenceTimeMs)).toBe("resets in 4 h");
    expect(formatQuotaReset("2026-07-24T03:00:00Z", referenceTimeMs)).toBe("resets 2026-07-24");
    expect(formatQuotaReset("2026-07-20T09:00:00Z", referenceTimeMs)).toBe("resets now");
    expect(formatQuotaReset(undefined, referenceTimeMs)).toBeNull();
    expect(formatQuotaReset("not-a-date", referenceTimeMs)).toBeNull();
  });
});

describe("quota observation state", () => {
  it("shows relative staleness when a probe has run", () => {
    const view = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ entries: [{ currency: "USD", total: "5.00" }] }),
    });
    expect(view.observedLabel).toBe("Updated 3 min ago");
    expect(view.reason).toBeNull();
  });

  it("distinguishes 'not yet queried' from both a value and an error", () => {
    const noRow = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: undefined,
    });
    expect(noRow.observedLabel).toBe(QUOTA_NOT_QUERIED_LABEL);
    expect(noRow.reason).toBeNull();
    expect(noRow.tone).toBe("neutral");
    expect(noRow.balances).toEqual([]);
    expect(noRow.windows).toEqual([]);

    const neverObserved = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ observedAt: null }),
    });
    expect(neverObserved.observedLabel).toBe(QUOTA_NOT_QUERIED_LABEL);
  });

  it("renders the reason for an error code instead of a zero value", () => {
    for (const errorCode of ["not_supported", "requires_separate_credential"] as const) {
      const view = buildProviderQuotaConnectionView({
        referenceTimeMs,
        sharedBalanceKeys: new Set<string>(),
        summary: summaryOf({ entries: [], errorCode }),
      });
      expect(view.reason).toBe(readQuotaErrorReason(errorCode));
      expect(view.reason).toBeTruthy();
      expect(view.balances).toEqual([]);
      expect(view.windows).toEqual([]);
      // The reason pill stands alone: staleness only matters for real quota
      // numbers, so no "Updated X ago" next to an error state.
      expect(view.observedLabel).toBeNull();
      // An expected state must not be styled or worded as a failure.
      expect(view.tone).toBe("expected");
      expect(view.reason?.toLowerCase()).not.toMatch(/error|fail/);
    }
  });

  it("marks an actual probe failure as a warning, still without a zero value", () => {
    for (const errorCode of ["probe_failed", "unauthorized"] as const) {
      const view = buildProviderQuotaConnectionView({
        referenceTimeMs,
        sharedBalanceKeys: new Set<string>(),
        summary: summaryOf({ entries: [], errorCode }),
      });
      expect(view.tone).toBe("warn");
      expect(view.reason).toBe(readQuotaErrorReason(errorCode));
      expect(view.balances).toEqual([]);
      expect(view.windows).toEqual([]);
      expect(view.observedLabel).toBeNull();
    }
  });

  it("renders local connections as not reported rather than forever not-yet-queried", () => {
    // Local Providers have no billing and the enqueue scan never enumerates
    // them, so "Not yet queried" would be a promise that never resolves.
    const local = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({
        connectionKind: "local",
        connectionLabel: "Local connection",
        observedAt: null,
        providerKey: "ollama",
      }),
    });

    expect(local.reason).toBe(readQuotaErrorReason("not_supported"));
    expect(local.tone).toBe("expected");
    expect(local.observedLabel).toBeNull();
    expect(local.pausedLabel).toBeNull();
    expect(local.windows).toEqual([]);
    expect(local.balances).toEqual([]);

    // A disabled local provider is still simply "not reported" — pausing is
    // about probing, which never applies to local.
    const disabledLocal = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({
        connectionKind: "local",
        observedAt: null,
        probingEnabled: false,
        providerKey: "ollama",
      }),
    });
    expect(disabledLocal.reason).toBe(readQuotaErrorReason("not_supported"));
    expect(disabledLocal.pausedLabel).toBeNull();
  });

  it("labels a successful probe that reported nothing, so the cell is never blank", () => {
    // openrouter with no spending limit configured is the main case: the probe
    // succeeds, emits no entry, and without a label only "Updated ..." remains.
    const empty = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ entries: [], providerKey: "openrouter" }),
    });
    expect(empty.emptyLabel).toBe(QUOTA_NO_LIMITS_LABEL);

    const withData = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ entries: [{ currency: "USD", total: "5.00" }] }),
    });
    expect(withData.emptyLabel).toBeNull();

    const neverProbed = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ observedAt: null }),
    });
    expect(neverProbed.emptyLabel).toBeNull();

    const errored = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ errorCode: "probe_failed" }),
    });
    expect(errored.emptyLabel).toBeNull();
  });

  it("shows paused instead of ever-aging stale numbers once probing stops", () => {
    // A disabled connection (or quota_probe_enabled = false) is skipped by the
    // enqueue scan, so whatever the row holds only gets older. Rendering those
    // numbers as if they were live is misleading; the cell says paused instead.
    const view = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({
        entries: [{ resetsAt: "2026-07-20T12:00:00Z", utilization: 0.24, window: "five_hour" }],
        probingEnabled: false,
      }),
    });

    expect(view.pausedLabel).toBe(QUOTA_PROBING_PAUSED_LABEL);
    expect(view.windows).toEqual([]);
    expect(view.balances).toEqual([]);
    expect(view.observedLabel).toBeNull();
    expect(view.tone).toBe("neutral");

    // Paused also beats a recorded error: the reason describes the last
    // attempt, which no longer runs.
    const pausedError = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ errorCode: "unauthorized", probingEnabled: false }),
    });
    expect(pausedError.pausedLabel).toBe(QUOTA_PROBING_PAUSED_LABEL);
    expect(pausedError.reason).toBeNull();

    // An active connection never renders the paused label.
    const active = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys: new Set<string>(),
      summary: summaryOf({ entries: [{ currency: "USD", total: "5.00" }] }),
    });
    expect(active.pausedLabel).toBeNull();
  });
});

describe("account-scoped balances", () => {
  const identical = (id: string) =>
    summaryOf({ entries: [{ currency: "USD", total: "76.50" }], id });

  it("collapses an identical balance across connections into one account-level pool", () => {
    const shared = findSharedProviderBalances([identical("a"), identical("b"), identical("c")]);
    expect(shared).toEqual([
      {
        connectionCount: 3,
        key: quotaBalanceKey({ currency: "USD", total: "76.50" }),
        label: "76.50 USD",
      },
    ]);
  });

  it("keeps genuinely different per-connection balances separate", () => {
    const shared = findSharedProviderBalances([
      identical("a"),
      summaryOf({ entries: [{ currency: "USD", total: "12.00" }], id: "b" }),
    ]);
    expect(shared).toEqual([]);
  });

  it("does not collapse a balance held by a single connection", () => {
    expect(findSharedProviderBalances([identical("a")])).toEqual([]);
  });

  it("omits a shared balance from the connection row so N rows do not read as N pools", () => {
    const sharedBalanceKeys = new Set([quotaBalanceKey({ currency: "USD", total: "76.50" })]);
    const view = buildProviderQuotaConnectionView({
      referenceTimeMs,
      sharedBalanceKeys,
      summary: identical("a"),
    });
    expect(view.balances).toEqual([]);
    expect(view.sharedBalanceNote).toBeTruthy();
  });
});

describe("providers page wiring", () => {
  it("loads the quota read model and passes it into the rendered provider section", () => {
    const page = readFileSync("apps/console/src/app/(dashboard)/providers/page.tsx", "utf8");
    expect(page).toContain("listConsoleProviderQuotaSummaries");
    // Only the selected provider's quota reaches the detail panel, so the panel
    // can never show another provider's plan.
    expect(page).toContain("quotas.filter((quota) => quota.providerId === selected.id)");

    const panel = readFileSync("apps/console/src/app/_ui/quota-panel.tsx", "utf8");
    expect(panel).toContain("buildProviderQuotaConnectionView");
    expect(panel).toContain("findSharedProviderBalances");
  });

  it("exports the read model as its own package subpath", () => {
    const packageJson = JSON.parse(readFileSync("packages/db/package.json", "utf8")) as {
      exports: Record<string, { default: string; types: string }>;
    };
    expect(packageJson.exports["./console-provider-quota"]).toEqual({
      default: "./src/console-provider-quota.ts",
      types: "./src/console-provider-quota.ts",
    });
  });
});
