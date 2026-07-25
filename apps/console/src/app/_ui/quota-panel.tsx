import type { ConsoleProviderQuotaSummary } from "@llmingress/db/console-provider-quota";
import { isWindowEntry } from "@llmingress/domain/quota";
import { Meter } from "./controls";
import { SectionTitle } from "./layout";
import {
  buildProviderQuotaConnectionView,
  findSharedProviderBalances,
} from "./provider-quota-format";

/**
 * Plan quota. A provider reports either rolling windows (utilization plus a
 * reset time) or a balance — both render, and balances get no progress bar
 * because there is nothing for them to be a fraction of.
 *
 * The states that are not numbers matter just as much: a local provider has no
 * billing to report, a paused probe means the stored row is only ageing, and a
 * provider documented not to expose quota is not a failure.
 */
export function PlanQuotaPanel({
  now,
  summaries,
  title = "Plan quota",
}: {
  now: Date;
  summaries: ConsoleProviderQuotaSummary[];
  title?: string;
}) {
  if (summaries.length === 0) {
    return null;
  }
  const referenceTimeMs = now.getTime();
  const shared = findSharedProviderBalances(summaries);
  const sharedBalanceKeys = new Set(shared.map((entry) => entry.key));

  const rows = summaries.map((summary) => ({
    summary,
    view: buildProviderQuotaConnectionView({ referenceTimeMs, sharedBalanceKeys, summary }),
    windowEntries: summary.entries.filter(isWindowEntry),
  }));

  return (
    <div>
      <SectionTitle className="mt-5">{title}</SectionTitle>
      <div className="mt-2 border-t border-hair">
        {shared.map((balance) => (
          <div key={balance.key} className="border-b border-rule2 py-[9px]">
            <div className="flex justify-between gap-3 font-mono text-13 text-ink">
              <span className="cell-clip">{balance.label}</span>
              <span className="flex-none text-dim">
                shared by {balance.connectionCount} connections
              </span>
            </div>
          </div>
        ))}

        {rows.map(({ summary, view, windowEntries }) => (
          <div key={summary.id} className="border-b border-rule2 py-[9px]">
            <div className="flex justify-between gap-3 font-mono text-13 text-ink">
              <span className="cell-clip">
                {summary.providerDisplayName} · {summary.connectionLabel}
              </span>
              {view.pausedLabel ? (
                <span className="flex-none text-faint">{view.pausedLabel}</span>
              ) : view.reason ? (
                <span className={`flex-none ${view.tone === "warn" ? "text-ambtx" : "text-faint"}`}>
                  {view.reason}
                </span>
              ) : view.emptyLabel ? (
                <span className="flex-none text-faint">{view.emptyLabel}</span>
              ) : null}
            </div>

            {view.windows.map((windowView, index) => {
              const utilization = windowEntries[index]?.utilization ?? 0;
              const tone =
                utilization >= 0.9
                  ? { fill: "bg-red", text: "text-redtx" }
                  : utilization >= 0.6
                    ? { fill: "bg-amber", text: "text-ambtx" }
                    : { fill: "bg-green", text: "text-green" };
              return (
                <div key={windowView.label} className="mt-[5px]">
                  <div className="flex justify-between font-mono text-13 text-ink">
                    <span>{windowView.label}</span>
                    <span className={`font-medium ${tone.text}`}>{windowView.percent} used</span>
                  </div>
                  <Meter className="mt-[5px]" fillClassName={tone.fill} ratio={utilization} />
                  {windowView.resetLabel ? (
                    <div className="mt-1 font-mono text-12 text-faint">{windowView.resetLabel}</div>
                  ) : null}
                </div>
              );
            })}

            {view.balances.map((balance) => (
              <div
                key={balance}
                className="mt-[5px] flex justify-between font-mono text-13 text-ink"
              >
                <span>balance</span>
                <span className="font-medium">{balance}</span>
              </div>
            ))}

            {view.sharedBalanceNote ? (
              <div className="mt-1 font-mono text-12 text-faint">{view.sharedBalanceNote}</div>
            ) : null}
            {view.observedLabel ? (
              <div className="mt-1 font-mono text-12 text-faint">{view.observedLabel}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
