import type {
  ConsoleUsageBreakouts,
  ConsoleUsageDimensionBreakdown,
} from "@llmingress/db/console-usage";
import { SegmentBar } from "../charts";
import { Meter } from "../controls";
import { activityHref, activityWindowForUsageWindow } from "../cross-links";
import { formatCompact, formatCost, formatCount, formatLatency, formatPercent } from "../format";
import { SectionTitle } from "../layout";
import { GridRow } from "../table";

const DISTRIBUTION_COLUMNS = "148px 1fr 62px 68px 62px 64px";

/** One of the four aligned 2×2 distribution tables. */
export function DistributionTable({
  lastColumn,
  rows,
  title,
  unit,
}: {
  lastColumn: "AVG LAT" | "FAILS";
  rows: ConsoleUsageDimensionBreakdown[];
  title: string;
  unit: string;
}) {
  const total = rows.reduce((sum, row) => sum + row.requestCount, 0);

  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={DISTRIBUTION_COLUMNS} gap={8} head>
          <span>{unit}</span>
          <span>SHARE</span>
          <span className="text-right">REQS</span>
          <span className="text-right">TOKENS</span>
          <span className="text-right">COST</span>
          <span className="text-right">{lastColumn}</span>
        </GridRow>
        {rows.length === 0 ? (
          <p className="py-4 font-mono text-13 text-dim">No traffic in this window.</p>
        ) : (
          rows.map((row) => (
            <GridRow key={row.id} columns={DISTRIBUTION_COLUMNS} gap={8}>
              <span className="font-medium cell-clip">{row.label}</span>
              <Meter ratio={total > 0 ? row.requestCount / total : 0} />
              <span className="text-right tabnum">{formatCount(row.requestCount)}</span>
              <span className="text-right tabnum">{formatCompact(row.totalTokens)}</span>
              <span className="text-right tabnum">{formatCost(row.totalCostUsd)}</span>
              <span className="text-right tabnum">
                {lastColumn === "AVG LAT"
                  ? formatLatency(row.avgLatencyMs)
                  : formatCount(row.failureCount)}
              </span>
            </GridRow>
          ))
        )}
      </div>
    </div>
  );
}

const PROTOCOL_COLUMNS = "140px 1fr 62px 64px";
const STATUS_COLUMNS = "140px 1fr 68px 64px";
const ERROR_COLUMNS = "150px 50px 1fr 62px";

export function ProtocolPanel({ breakouts }: { breakouts: ConsoleUsageBreakouts }) {
  const total = breakouts.protocols.reduce((sum, row) => sum + row.requestCount, 0);
  const streamTotal = breakouts.streaming.streamed + breakouts.streaming.nonStreamed;

  return (
    <div>
      <SectionTitle>Protocol mix</SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={PROTOCOL_COLUMNS} gap={8} head>
          <span>PROTOCOL</span>
          <span>SHARE</span>
          <span className="text-right">REQS</span>
          <span className="text-right">AVG LAT</span>
        </GridRow>
        {breakouts.protocols.map((row) => (
          <GridRow key={row.protocol} columns={PROTOCOL_COLUMNS} gap={8}>
            <span className="font-medium cell-clip">{row.protocol}</span>
            <Meter ratio={total > 0 ? row.requestCount / total : 0} />
            <span className="text-right tabnum">{formatCount(row.requestCount)}</span>
            <span className="text-right tabnum">{formatLatency(row.avgLatencyMs)}</span>
          </GridRow>
        ))}
      </div>
      <div className="mt-[14px] font-mono text-115 font-medium tracking-[.08em] text-dim">
        STREAMING
      </div>
      <div className="mt-[6px] flex h-[9px] bg-track">
        <div
          className="bg-accent"
          style={{
            width:
              streamTotal > 0
                ? `${((breakouts.streaming.streamed / streamTotal) * 100).toFixed(2)}%`
                : "0%",
          }}
        />
      </div>
      <div className="mt-[6px] flex gap-3 font-mono text-12 text-dim">
        <span>
          stream{" "}
          {streamTotal > 0 ? formatPercent(breakouts.streaming.streamed / streamTotal, 0) : "—"}
        </span>
        <span>
          non-stream{" "}
          {streamTotal > 0 ? formatPercent(breakouts.streaming.nonStreamed / streamTotal, 0) : "—"}
        </span>
      </div>
    </div>
  );
}

export function StatusPanel({ breakouts }: { breakouts: ConsoleUsageBreakouts }) {
  const total = breakouts.statuses.reduce((sum, row) => sum + row.requestCount, 0);
  const fill: Record<string, string> = {
    canceled: "bg-dim",
    failed: "bg-red",
    started: "bg-amber",
    succeeded: "bg-green",
  };

  return (
    <div>
      <SectionTitle>Status</SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={STATUS_COLUMNS} gap={8} head>
          <span>STATUS</span>
          <span>SHARE</span>
          <span className="text-right">REQS</span>
          <span className="text-right">SHARE %</span>
        </GridRow>
        {breakouts.statuses.map((row) => (
          <GridRow key={row.status} columns={STATUS_COLUMNS} gap={8}>
            <span className="font-medium cell-clip">{row.status}</span>
            <Meter
              fillClassName={fill[row.status] ?? "bg-accent"}
              ratio={total > 0 ? row.requestCount / total : 0}
            />
            <span className="text-right tabnum">{formatCount(row.requestCount)}</span>
            <span className="text-right tabnum">
              {total > 0 ? formatPercent(row.requestCount / total, 2) : "—"}
            </span>
          </GridRow>
        ))}
      </div>
      <div className="mt-[14px] font-mono text-115 font-medium tracking-[.08em] text-dim">
        FALLBACK ATTEMPTS
      </div>
      <div className="mt-[6px]">
        <FallbackRow label="recovered on retry" value={breakouts.fallback.recoveredOnRetry} />
        <FallbackRow
          danger
          label="failed after last candidate"
          value={breakouts.fallback.failedAfterLastCandidate}
        />
      </div>
    </div>
  );
}

function FallbackRow({
  danger = false,
  label,
  value,
}: {
  danger?: boolean;
  label: string;
  value: number;
}) {
  return (
    <div className="flex justify-between border-b border-rule2 py-[6px] font-mono text-13">
      <span className="text-dim">{label}</span>
      <span className={danger ? "text-redtx tabnum" : "tabnum"}>{formatCount(value)}</span>
    </div>
  );
}

export function TopErrorsPanel({
  breakouts,
  window,
}: {
  breakouts: ConsoleUsageBreakouts;
  /** The Usage window, so Activity opens on the same span of failures. */
  window: string;
}) {
  const max = Math.max(1, ...breakouts.topErrors.map((row) => row.count));

  return (
    <div>
      <SectionTitle
        trailing={
          <a
            href={activityHref({
              status: "failed",
              window: activityWindowForUsageWindow(window),
            })}
            className="font-mono text-13 text-dim"
          >
            → Activity
          </a>
        }
      >
        Top errors
      </SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={ERROR_COLUMNS} gap={8} head>
          <span>ERROR CODE</span>
          <span className="text-right">HTTP</span>
          <span>SHARE</span>
          <span className="text-right">COUNT</span>
        </GridRow>
        {breakouts.topErrors.length === 0 ? (
          <p className="py-4 font-mono text-13 text-dim">No failed request in this window.</p>
        ) : (
          breakouts.topErrors.map((row) => (
            <GridRow key={row.errorCode} columns={ERROR_COLUMNS} gap={8}>
              <span className="font-medium cell-clip">{row.errorCode}</span>
              <span className="text-right tabnum">{row.httpStatus ?? "—"}</span>
              <Meter fillClassName="bg-red" ratio={row.count / max} />
              <span className="text-right tabnum">{formatCount(row.count)}</span>
            </GridRow>
          ))
        )}
      </div>
      <p className="mt-2 font-mono text-12 leading-[1.6] text-faint">
        Counts come from request_activity error codes; a request that later succeeded on another
        candidate is counted once here and once as a recovered fallback.
      </p>
    </div>
  );
}

/**
 * Every source the schema allows, in the order the schema lists them, whether
 * or not the window saw one. A source that produced nothing is a fact about the
 * window — dropping its row makes the reader work out which one is missing, and
 * a colour bound to a row's position changes meaning when the counts reorder.
 */
const TOKEN_SOURCES = [
  { className: "bg-accent", source: "provider" },
  { className: "bg-amber", source: "estimated" },
  { className: "bg-dim", source: "unavailable" },
] as const;

/**
 * The two dashes on this panel mean different things, so only one of them is a
 * dash: a priced source that produced nothing costs $0.00, which is an amount;
 * plan traffic records no metered cost at all, which is not an amount of zero.
 */
const COST_SOURCES = [
  { label: "provider", metered: true, source: "provider" },
  { label: "estimated", metered: true, source: "estimated" },
  { label: "reconciled", metered: true, source: "reconciled" },
  { label: "unavailable / plan", metered: false, source: "unavailable" },
] as const;

export function DataQualityPanel({ breakouts }: { breakouts: ConsoleUsageBreakouts }) {
  const tokenSourceCount = (source: string) =>
    breakouts.tokenSources.find((entry) => entry.source === source)?.requestCount ?? 0;
  const costSource = (source: string) =>
    breakouts.costSources.find((entry) => entry.source === source);

  return (
    <div>
      <SectionTitle>Data quality</SectionTitle>
      <div className="mt-[10px] font-mono text-115 font-medium tracking-[.08em] text-dim">
        TOKEN SOURCE
      </div>
      <SegmentBar
        segments={TOKEN_SOURCES.map((entry) => ({
          className: entry.className,
          label: entry.source,
          value: tokenSourceCount(entry.source),
        }))}
      />

      <div className="mt-[14px] font-mono text-115 font-medium tracking-[.08em] text-dim">
        COST SOURCE
      </div>
      <div className="mt-[6px]">
        {COST_SOURCES.map(({ label, metered, source }) => {
          const entry = costSource(source);
          return (
            <div
              key={source}
              className="flex justify-between border-b border-rule2 py-[6px] font-mono text-13"
            >
              <span className="text-dim">{label}</span>
              <span className={entry ? "tabnum" : "tabnum text-faint"}>
                {metered ? formatCost(entry?.totalCostUsd ?? "0") : "—"} ·{" "}
                {formatCount(entry?.requestCount ?? 0)} reqs
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 font-mono text-12 leading-[1.6] text-faint">
        Prices come from the sync job or a manual override; estimated rows use the last known price
        at request time, and subscription plans record no metered cost at all.
      </p>
    </div>
  );
}
