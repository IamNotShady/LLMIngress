import {
  type ConsoleUsageWindow,
  getConsoleUsageBreakouts,
  getConsoleUsageSummary,
} from "@llmingress/db/console-usage";
import { ChartLegend, StackedBarChart } from "../../_ui/charts";
import { ActionLink } from "../../_ui/controls";
import {
  failureRateTone,
  failureRateToneClass,
  formatCompact,
  formatCost,
  formatCount,
  formatLatency,
  formatPercent,
} from "../../_ui/format";
import { EmptyState, PageShell } from "../../_ui/layout";
import { readParam, type SearchParams } from "../../_ui/params";
import {
  DataQualityPanel,
  DistributionTable,
  ProtocolPanel,
  StatusPanel,
  TopErrorsPanel,
} from "../../_ui/usage/panels";
import { axisLabelsForWindow, readUsageWindow, WindowPicker } from "../../_ui/usage/window";

export default async function UsagePage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();
  const window: ConsoleUsageWindow = readUsageWindow(readParam(params, "window"));

  const [usage, breakouts] = await Promise.all([
    getConsoleUsageSummary({ now, window }),
    getConsoleUsageBreakouts({ now, window }),
  ]);

  const requestSeries = [
    {
      className: "bg-accent opacity-90",
      label: "succeeded",
      values: usage.trend.map((point) => point.requestCount - point.failureCount),
    },
    {
      className: "bg-red",
      label: "failed",
      values: usage.trend.map((point) => point.failureCount),
    },
  ];
  const costSeries = [
    {
      className: "bg-ink2 opacity-75",
      label: "cost",
      values: usage.trend.map((point) => Number.parseFloat(point.totalCostUsd ?? "0") || 0),
    },
  ];
  const tokenSeries = [
    {
      className: "bg-accent",
      label: "input",
      values: usage.trend.map((point) => Math.max(0, point.inputTokens - point.cachedInputTokens)),
    },
    {
      className: "bg-accent opacity-45",
      label: "cached input",
      values: usage.trend.map((point) => point.cachedInputTokens),
    },
    {
      className: "bg-green",
      label: "output",
      values: usage.trend.map((point) => point.outputTokens),
    },
    {
      className: "bg-amber",
      label: "reasoning",
      values: usage.trend.map((point) => point.reasoningTokens),
    },
  ];
  const axisLabels = axisLabelsForWindow(window, usage.trend, now);

  const windowMinutes = window === "24h" ? 24 * 60 : window === "7d" ? 7 * 24 * 60 : 30 * 24 * 60;
  const fallbackServed = breakouts.fallback.recoveredOnRetry;

  return (
    <PageShell label="Usage">
      <div className="flex items-baseline gap-4 overflow-x-auto pt-[22px]">
        <h1 className="font-sans text-25 font-semibold tracking-[-.02em] text-ink">Usage</h1>
        <WindowPicker params={params} pathname="/usage" window={window} />
        <span className="ml-auto font-mono text-13 text-faint">
          {window} window · buckets are {window === "24h" ? "hourly" : "daily"} · UTC
        </span>
      </div>

      {usage.requestCount === 0 ? (
        <EmptyState
          title="Nothing to report yet"
          body="Usage aggregates request records — trends, provider and key breakdowns and cost attribution appear after the first requests land."
          actions={
            <ActionLink href="/playground" tone="primary">
              Open Playground
            </ActionLink>
          }
        />
      ) : (
        <>
          <div className="mt-4 overflow-x-auto border-y border-hair border-b-rule">
            <div className="grid min-w-[1100px] grid-cols-7">
              <Kpi label="REQUESTS" value={formatCount(usage.requestCount)}>
                {(usage.requestCount / windowMinutes).toFixed(2)} req/min avg
              </Kpi>
              <Kpi label="TOKENS" value={formatCompact(usage.totalTokens)}>
                {formatCompact(usage.inputTokens)} in / {formatCompact(usage.outputTokens)} out
              </Kpi>
              <Kpi label="COST" value={formatCost(usage.totalCostUsd)}>
                {formatCost(
                  (Number.parseFloat(usage.totalCostUsd ?? "0") || 0) / usage.requestCount,
                )}{" "}
                / req
              </Kpi>
              <Kpi
                label="FAILURE RATE"
                tone={
                  failureRateToneClass[failureRateTone(usage.failureCount / usage.requestCount)]
                }
                value={formatPercent(usage.failureCount / usage.requestCount, 2)}
              >
                {formatCount(usage.failureCount)} failed
              </Kpi>
              <Kpi label="AVG LATENCY" value={formatLatency(usage.avgLatencyMs)}>
                first byte, mean
              </Kpi>
              <Kpi
                label="CACHED INPUT"
                value={
                  usage.inputTokens > 0
                    ? formatPercent(usage.cachedInputTokens / usage.inputTokens, 1)
                    : "—"
                }
              >
                {formatCompact(usage.cachedInputTokens)} cached
              </Kpi>
              <Kpi
                label="SERVED BY FALLBACK"
                value={formatPercent(fallbackServed / usage.requestCount, 2)}
              >
                {formatCount(fallbackServed)} requests
              </Kpi>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 overflow-x-auto py-5">
            <div>
              <div className="flex items-baseline">
                <span className="font-sans text-155 font-semibold text-ink">Requests</span>
                <ChartLegend series={requestSeries} />
              </div>
              <StackedBarChart axisLabels={axisLabels} series={requestSeries} />
            </div>
            <div>
              <div className="flex items-baseline">
                <span className="font-sans text-155 font-semibold text-ink">Cost</span>
                <span className="ml-auto font-mono text-12 text-dim">
                  metered spend only — subscription plans bill $0
                </span>
              </div>
              <StackedBarChart axisLabels={axisLabels} series={costSeries} />
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-x-8 pb-5 overflow-x-auto">
            <div>
              <div className="flex items-baseline">
                <span className="font-sans text-155 font-semibold text-ink">Token composition</span>
                <ChartLegend series={tokenSeries} />
              </div>
              <StackedBarChart axisLabels={axisLabels} height={130} series={tokenSeries} />
            </div>
            <DataQualityPanel breakouts={breakouts} />
          </div>

          <div className="grid grid-cols-2 items-start gap-x-8 gap-y-6 overflow-x-auto">
            <DistributionTable
              lastColumn="AVG LAT"
              rows={usage.providerBreakdowns}
              title="By provider"
              unit="PROVIDER"
            />
            <DistributionTable
              lastColumn="FAILS"
              rows={usage.apiKeyBreakdowns}
              title="By API key"
              unit="API KEY"
            />
            <DistributionTable
              lastColumn="AVG LAT"
              rows={usage.modelBreakdowns}
              title="By model"
              unit="MODEL"
            />
            <DistributionTable
              lastColumn="AVG LAT"
              rows={usage.virtualModelBreakdowns}
              title="By virtual model"
              unit="VIRTUAL MODEL"
            />
          </div>

          <div className="mt-6 grid grid-cols-3 gap-x-8 overflow-x-auto">
            <ProtocolPanel breakouts={breakouts} />
            <StatusPanel breakouts={breakouts} />
            <TopErrorsPanel breakouts={breakouts} />
          </div>
        </>
      )}
    </PageShell>
  );
}

function Kpi({
  children,
  label,
  tone = "text-ink",
  value,
}: {
  children: React.ReactNode;
  label: string;
  tone?: string;
  value: string;
}) {
  return (
    <div className="px-4 pb-4 pt-[14px] first:pl-0 last:pr-0">
      <div className="font-mono text-12 font-medium tracking-[.12em] text-dim">{label}</div>
      <div className={`mt-[6px] font-mono text-31 font-medium tracking-[-.03em] ${tone} tabnum`}>
        {value}
      </div>
      <div className="mt-[3px] font-mono text-13 text-dim">{children}</div>
    </div>
  );
}
