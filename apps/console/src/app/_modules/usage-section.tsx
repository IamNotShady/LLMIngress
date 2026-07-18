import { listAgents } from "@llmingress/db/console-agents";
import {
  formatConsoleCompactCount,
  formatConsoleUsd,
  MISSING_VALUE,
} from "@llmingress/db/console-format";
import { listProviders } from "@llmingress/db/console-providers";
import {
  type ConsoleUsageDimensionBreakdown,
  type ConsoleUsageTrendPoint,
  getConsoleUsageSummary,
  parseConsoleUsageWindow,
} from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { TrendLineChart } from "../_components/charts/trend-line-chart";
import { StatCard } from "../_components/stat-card";
import { resolveConsoleUsageDateRange } from "../_lib/usage-date-range";
import {
  type ConsoleSearchParams,
  failureRateTone,
  readSingleSearchParam,
  toneToNumClass,
} from "./sections";

const usageTrendActualColor = "var(--chart-3)";

const usageTrendBaselineColor = "var(--chart-2)";

const usageTrendTokenColor = "var(--chart-4)";

function UsageCostDonut({
  breakdowns,
  label,
}: {
  breakdowns: ConsoleUsageDimensionBreakdown[];
  label: string;
}) {
  const slices = breakdowns
    .map((breakdown) => ({
      id: breakdown.id,
      name: breakdown.label,
      value: Number(breakdown.totalCostUsd ?? 0),
    }))
    .filter((slice) => slice.value > 0)
    .slice(0, 6);
  if (slices.length === 0) {
    return <p>No {label} cost recorded.</p>;
  }
  return <DonutBreakdown ariaLabel={`${label} cost breakdown`} data={slices} valueFormat="usd" />;
}

function readOptionalFilterParam(value: string | string[] | undefined): string | null {
  const param = readSingleSearchParam(value)?.trim();
  return param ? param : null;
}

function formatCostTrendPoint(point: ConsoleUsageTrendPoint) {
  return {
    costUsd: Number(point.totalCostUsd ?? 0),
    label: formatUsageTrendLabel(point.bucketStart),
  };
}

function formatTokenTrendPoint(point: ConsoleUsageTrendPoint) {
  return {
    inputTokens: point.inputTokens,
    label: formatUsageTrendLabel(point.bucketStart),
    outputTokens: point.outputTokens,
  };
}

const usageTrendLabelFormat = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "short",
});

function formatUsageTrendLabel(value: Date): string {
  return usageTrendLabelFormat.format(value);
}

function formatLatencyMs(value: number | null): string {
  if (value === null) {
    return MISSING_VALUE;
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${(value / 1000).toFixed(2)}s`;
}

function formatFailureRate(failureCount: number, requestCount: number): string {
  if (requestCount <= 0) {
    return "0.00%";
  }
  return `${((failureCount / requestCount) * 100).toFixed(2)}%`;
}
export async function UsageSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const usageWindow = parseConsoleUsageWindow(readSingleSearchParam(searchParams.usageWindow));
  const dateFromParam = readSingleSearchParam(searchParams.dateFrom);
  const dateToParam = readSingleSearchParam(searchParams.dateTo);
  const selectedAgentId = readOptionalFilterParam(searchParams.agentId);
  const selectedVirtualModelId = readOptionalFilterParam(searchParams.virtualModelId);
  const selectedProviderId = readOptionalFilterParam(searchParams.providerId);
  const now = new Date();
  const usageDateRange = resolveConsoleUsageDateRange({
    dateFrom: dateFromParam,
    dateTo: dateToParam,
    now,
    window: usageWindow,
  });
  const { dateFromValue, dateToValue } = usageDateRange;
  const [usageSummary, agents, virtualModels, providers] = await Promise.all([
    getConsoleUsageSummary({
      agentId: selectedAgentId,
      dateFrom: usageDateRange.start,
      dateTo: usageDateRange.endExclusive,
      now,
      providerId: selectedProviderId,
      virtualModelId: selectedVirtualModelId,
      window: usageWindow,
    }),
    listAgents(),
    listVirtualModels(),
    listProviders(),
  ]);

  const failureRate =
    usageSummary.requestCount > 0
      ? `${((usageSummary.failureCount / usageSummary.requestCount) * 100).toFixed(2)}%`
      : "0.00%";
  const avgLatency = formatLatencyMs(usageSummary.avgLatencyMs);
  const costTrend = usageSummary.trend.map(formatCostTrendPoint);
  const tokenTrend = usageSummary.trend.map(formatTokenTrendPoint);

  return (
    <section className="providers-panel usage-dashboard" id="usage" aria-label="Usage & Cost">
      <form className="usage-filter-bar" action="/usage" method="get">
        <input type="hidden" name="usageWindow" value={usageSummary.window} />
        <fieldset className="usage-date-range" aria-label="Date range">
          <div className="usage-date-range-fields">
            <div className="console-field">
              <label htmlFor="usage-date-from">Start date</label>
              <input
                type="date"
                id="usage-date-from"
                name="dateFrom"
                defaultValue={dateFromValue}
              />
            </div>
            <div className="console-field">
              <label htmlFor="usage-date-to">End date</label>
              <input type="date" id="usage-date-to" name="dateTo" defaultValue={dateToValue} />
            </div>
          </div>
        </fieldset>
        <div className="console-field">
          <label htmlFor="usage-agent">Agent</label>
          <select id="usage-agent" name="agentId" defaultValue={selectedAgentId ?? ""}>
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        <div className="console-field">
          <label htmlFor="usage-virtual-model">Virtual Model</label>
          <select
            id="usage-virtual-model"
            name="virtualModelId"
            defaultValue={selectedVirtualModelId ?? ""}
          >
            <option value="">All virtual models</option>
            {virtualModels.map((virtualModel) => (
              <option key={virtualModel.id} value={virtualModel.id}>
                {virtualModel.name}
              </option>
            ))}
          </select>
        </div>
        <div className="console-field">
          <label htmlFor="usage-provider">Provider</label>
          <select id="usage-provider" name="providerId" defaultValue={selectedProviderId ?? ""}>
            <option value="">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="console-actions">
          <button type="submit">
            <span>Filter</span>
          </button>
        </div>
      </form>

      <div className="stat-grid usage-kpi-grid">
        <StatCard icon="$" label="Total cost" value={formatConsoleUsd(usageSummary.totalCostUsd)} />
        <StatCard
          icon="TK"
          label="Total tokens"
          value={formatConsoleCompactCount(usageSummary.totalTokens)}
        />
        <StatCard
          icon="RQ"
          label="Total requests"
          value={formatConsoleCompactCount(usageSummary.requestCount)}
        />
        <StatCard icon="LT" label="Avg latency" value={avgLatency} />
        <StatCard
          icon="FR"
          label="Failure rate"
          value={failureRate}
          valueTone={failureRateTone(usageSummary.failureCount, usageSummary.requestCount)}
        />
      </div>

      <div className="usage-analysis-grid">
        <div className="chart-card">
          <h2 className="chart-card-title">Cost trend</h2>
          <TrendLineChart
            ariaLabel="Cost trend"
            emptyMessage="No cost recorded in this range."
            data={costTrend}
            series={[{ key: "costUsd", name: "Cost (USD)", color: usageTrendActualColor }]}
          />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Tokens trend</h2>
          <TrendLineChart
            ariaLabel="Tokens trend"
            emptyMessage="No tokens recorded in this range."
            data={tokenTrend}
            series={[
              { key: "inputTokens", name: "Input tokens", color: usageTrendBaselineColor },
              { key: "outputTokens", name: "Output tokens", color: usageTrendTokenColor },
            ]}
          />
        </div>
      </div>

      <div className="usage-distribution-grid">
        <div className="chart-card">
          <h2 className="chart-card-title">Agent cost distribution</h2>
          <UsageCostDonut breakdowns={usageSummary.agentBreakdowns} label="agent" />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Virtual Model cost distribution</h2>
          <UsageCostDonut breakdowns={usageSummary.virtualModelBreakdowns} label="virtual model" />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Provider cost distribution</h2>
          <UsageCostDonut breakdowns={usageSummary.providerBreakdowns} label="provider" />
        </div>
      </div>

      <div className="chart-card usage-summary-card">
        <h2 className="chart-card-title">Provider / Model summary</h2>
        <div className="data-table-wrap">
          <table className="data-table bounded-table usage-summary-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="num">Requests</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Avg latency</th>
                <th className="num">Failure rate</th>
              </tr>
            </thead>
            <tbody>
              {usageSummary.breakdowns.length === 0 ? (
                <tr>
                  <td colSpan={8}>No usage recorded for this range.</td>
                </tr>
              ) : (
                usageSummary.breakdowns.map((breakdown) => (
                  <tr key={`${breakdown.providerId}:${breakdown.modelId}`}>
                    <td>{breakdown.providerLabel}</td>
                    <td>{breakdown.modelLabel}</td>
                    <td className="num">{formatConsoleCompactCount(breakdown.requestCount)}</td>
                    <td className="num">{formatConsoleCompactCount(breakdown.totalTokens)}</td>
                    <td className="num">{formatConsoleUsd(breakdown.totalCostUsd)}</td>
                    <td className="num">{formatLatencyMs(breakdown.avgLatencyMs)}</td>
                    <td className="num">
                      <span
                        className={toneToNumClass(
                          failureRateTone(breakdown.failureCount, breakdown.requestCount),
                        )}
                      >
                        {formatFailureRate(breakdown.failureCount, breakdown.requestCount)}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
