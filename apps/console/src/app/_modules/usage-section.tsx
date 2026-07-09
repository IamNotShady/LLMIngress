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
  type ConsoleUsageWindow,
  getConsoleUsageSummary,
  parseConsoleUsageWindow,
} from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { TrendLineChart } from "../_components/charts/trend-line-chart";
import { StatCard } from "../_components/stat-card";
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

function parseUsageDateStart(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUsageDateEndExclusive(value: string | undefined): Date | null {
  const start = parseUsageDateStart(value);
  if (!start) {
    return null;
  }
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function getUsageDateInputValues(input: {
  dateFromParam: string | undefined;
  dateToParam: string | undefined;
  now: Date;
  window: ConsoleUsageWindow;
}): { dateFromValue: string; dateToValue: string } {
  const fallbackFrom = getUsageDateFallbackStart(input.now, input.window);
  return {
    dateFromValue: parseUsageDateStart(input.dateFromParam)
      ? (input.dateFromParam ?? formatUsageDateInput(fallbackFrom))
      : formatUsageDateInput(fallbackFrom),
    dateToValue: parseUsageDateStart(input.dateToParam)
      ? (input.dateToParam ?? formatUsageDateInput(input.now))
      : formatUsageDateInput(input.now),
  };
}

function getUsageDateFallbackStart(now: Date, window: ConsoleUsageWindow): Date {
  const durationMs = {
    "24h": 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  }[window];
  return new Date(now.getTime() - durationMs);
}

function formatUsageDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatCostTrendPoint(point: ConsoleUsageTrendPoint) {
  const actualCostUsd = Number(point.totalCostUsd ?? 0);
  const savingsUsd = Number(point.totalSavingsUsd ?? 0);
  return {
    actualCostUsd,
    baselineCostUsd: actualCostUsd + savingsUsd,
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

function formatUsageTrendLabel(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
  }).format(value);
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
  const { dateFromValue, dateToValue } = getUsageDateInputValues({
    dateFromParam,
    dateToParam,
    now,
    window: usageWindow,
  });
  const [usageSummary, agents, virtualModels, providers] = await Promise.all([
    getConsoleUsageSummary({
      agentId: selectedAgentId,
      dateFrom: parseUsageDateStart(dateFromValue),
      dateTo: parseUsageDateEndExclusive(dateToValue),
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
  const totalCost = Number(usageSummary.totalCostUsd ?? 0);
  const totalSavings = Number(usageSummary.totalSavingsUsd ?? 0);
  const savingsRatio =
    totalCost + totalSavings > 0
      ? `${((totalSavings / (totalCost + totalSavings)) * 100).toFixed(1)}%`
      : "0.0%";
  const baselineCost = totalCost + totalSavings;
  const lowCostHitRate =
    usageSummary.costedRequestCount > 0
      ? `${((usageSummary.lowCostRequestCount / usageSummary.costedRequestCount) * 100).toFixed(1)}%`
      : "0.0%";
  const avgLatency = formatLatencyMs(usageSummary.avgLatencyMs);
  const costTrend = usageSummary.trend.map(formatCostTrendPoint);
  const tokenTrend = usageSummary.trend.map(formatTokenTrendPoint);

  return (
    <section className="providers-panel usage-dashboard" id="usage" aria-label="Usage & Cost">
      <form className="usage-filter-bar" action="/usage" method="get">
        <input type="hidden" name="usageWindow" value={usageSummary.window} />
        <fieldset className="usage-date-range" aria-label="Date range">
          <legend>Date range</legend>
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
        <StatCard
          icon="SV"
          label="Estimated savings"
          value={formatConsoleUsd(usageSummary.totalSavingsUsd)}
        />
      </div>

      <div className="usage-analysis-grid">
        <div className="chart-card">
          <h2 className="chart-card-title">Cost trend</h2>
          <TrendLineChart
            ariaLabel="Cost trend"
            emptyMessage="No cost recorded in this range."
            data={costTrend}
            series={[
              { key: "baselineCostUsd", name: "Baseline (USD)", color: usageTrendBaselineColor },
              { key: "actualCostUsd", name: "Actual (USD)", color: usageTrendActualColor },
            ]}
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
        <div className="chart-card usage-savings-card">
          <h2 className="chart-card-title">Savings overview</h2>
          <dl className="usage-savings-list">
            <div>
              <dt>Saved amount</dt>
              <dd>{formatConsoleUsd(usageSummary.totalSavingsUsd)}</dd>
            </div>
            <div>
              <dt>Baseline cost</dt>
              <dd>{formatConsoleUsd(baselineCost.toFixed(8))}</dd>
            </div>
            <div>
              <dt>Savings ratio</dt>
              <dd>{savingsRatio}</dd>
            </div>
            <div>
              <dt>Low-cost hit rate</dt>
              <dd>{lowCostHitRate}</dd>
            </div>
          </dl>
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
          <table className="data-table usage-summary-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="num">Requests</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Avg latency</th>
                <th className="num">Failure rate</th>
                <th className="num">Savings</th>
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
                    <td className="num">{formatConsoleUsd(breakdown.totalSavingsUsd)}</td>
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
