import type { ConsoleProviderQuotaSummary } from "@llmingress/db/console-provider-quota";
import { isWindowEntry } from "@llmingress/domain/quota";
import { Meter } from "./controls";
import { formatRelative } from "./format";
import { SectionTitle } from "./layout";

/**
 * Plan quota. A provider may report either rolling windows (utilization plus a
 * reset time) or a balance (a currency total) — both render here, and balances
 * get no progress bar because there is nothing to be a fraction of.
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
  const rows = summaries.flatMap((summary) => summary.entries.map((entry) => ({ entry, summary })));
  if (rows.length === 0) {
    return null;
  }

  return (
    <div>
      <SectionTitle className="mt-5">{title}</SectionTitle>
      <div className="mt-2 border-t border-hair">
        {rows.map(({ entry, summary }) => {
          const label = `${summary.providerDisplayName} · ${
            isWindowEntry(entry) ? entry.window : entry.currency
          }`;
          const observed = `observed ${formatRelative(summary.observedAt, now)}`;

          if (!isWindowEntry(entry)) {
            return (
              <div
                key={`${summary.id}-${entry.currency}`}
                className="border-b border-rule2 py-[9px]"
              >
                <div className="flex justify-between font-mono text-13 text-ink">
                  <span>{label}</span>
                  <span className="font-medium">{entry.total}</span>
                </div>
                <div className="mt-1 font-mono text-12 text-faint">
                  {[
                    entry.granted ? `granted ${entry.granted}` : null,
                    entry.toppedUp ? `topped up ${entry.toppedUp}` : null,
                    observed,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            );
          }

          const tone =
            entry.utilization >= 0.9
              ? { text: "text-redtx", fill: "bg-red" }
              : entry.utilization >= 0.6
                ? { text: "text-ambtx", fill: "bg-amber" }
                : { text: "text-green", fill: "bg-green" };

          return (
            <div key={`${summary.id}-${entry.window}`} className="border-b border-rule2 py-[9px]">
              <div className="flex justify-between font-mono text-13 text-ink">
                <span>{label}</span>
                <span className={`font-medium ${tone.text}`}>
                  {Math.round(entry.utilization * 100)}% used
                </span>
              </div>
              <Meter className="mt-[5px]" fillClassName={tone.fill} ratio={entry.utilization} />
              <div className="mt-1 font-mono text-12 text-faint">
                {entry.resetsAt ? `resets ${entry.resetsAt} · ${observed}` : observed}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
