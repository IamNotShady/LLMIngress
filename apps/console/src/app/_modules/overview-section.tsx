import { type ConsoleActivity, listConsoleActivities } from "@llmingress/db/console-activity";
import {
  formatConsoleCompactCount,
  formatConsoleCount,
  formatConsoleTimestamp,
  formatConsoleUsd,
} from "@llmingress/db/console-format";
import {
  type ConsoleUsageDimensionBreakdown,
  type ConsoleUsageTrendPoint,
  getConsolePrevious24HourKpis,
  getConsoleUsageSummary,
} from "@llmingress/db/console-usage";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { chartAccent, chartOk } from "../_components/charts/palette";
import { TrendLineChart } from "../_components/charts/trend-line-chart";
import { StatCard } from "../_components/stat-card";
import {
  ActivityStatusPill,
  failureRateTone,
  formatActivityProviderLabel,
  formatActivityVirtualModelLabel,
  formatDeltaTone,
} from "./sections";

function formatOverviewTrendPoint(point: ConsoleUsageTrendPoint) {
  return {
    costUsd: Number(point.totalCostUsd ?? 0),
    label: point.bucketStart.toLocaleTimeString("en-US", {
      hour: "2-digit",
      hour12: false,
    }),
    requests: point.requestCount,
  };
}

function formatPreviousWindowPercentDelta(current: number, previous: number): string {
  if (previous === 0) {
    return current === 0 ? "vs previous 24h 0.0%" : "vs previous 24h new";
  }
  return `vs previous 24h ${formatSignedDecimal(((current - previous) / previous) * 100)}%`;
}

function formatPreviousWindowPointDelta(currentRate: number, previousRate: number): string {
  return `vs previous 24h ${formatSignedDecimal((currentRate - previousRate) * 100)}pp`;
}

function formatSignedDecimal(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function buildTopAgentsByCost(agentBreakdowns: ConsoleUsageDimensionBreakdown[]) {
  return agentBreakdowns
    .map((breakdown) => ({
      name: breakdown.label,
      value: Number(breakdown.totalCostUsd ?? 0),
    }))
    .filter((breakdown) => breakdown.value > 0)
    .sort((left, right) => right.value - left.value)
    .slice(0, 5);
}

function formatActivityModelSummary(activity: ConsoleActivity): string {
  return activity.providerModelName ?? activity.model ?? "Unknown model";
}
export async function OverviewSection() {
  const now = new Date();
  const overviewStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [usageSummary, previousKpis, recentActivities] = await Promise.all([
    getConsoleUsageSummary({ window: "24h" }),
    getConsolePrevious24HourKpis({ now }),
    listConsoleActivities({
      filters: { from: overviewStart },
      limit: 8,
    }),
  ]);
  const activeAgentCount = usageSummary.agentBreakdowns.filter(
    (agent) => agent.requestCount > 0,
  ).length;
  const failureRate =
    usageSummary.requestCount > 0
      ? `${((usageSummary.failureCount / usageSummary.requestCount) * 100).toFixed(2)}%`
      : "0.00%";
  const trend = usageSummary.trend.map(formatOverviewTrendPoint);
  const topAgents = buildTopAgentsByCost(usageSummary.agentBreakdowns);

  return (
    <section className="overview-dashboard" aria-label="Overview">
      {usageSummary.requestCount === 0 ? (
        <section className="chart-card core-onboarding" aria-labelledby="core-onboarding-title">
          <div className="core-onboarding-copy">
            <p className="eyebrow">Core setup</p>
            <h2 id="core-onboarding-title">Route your first request</h2>
            <p>Configure only the four building blocks required to send and monitor traffic.</p>
          </div>
          <ol className="core-onboarding-steps">
            <li>
              <a href="/providers?providerDialog=new">
                <span>1</span>
                Add a Provider
              </a>
            </li>
            <li>
              <a href="/models?virtualModelDialog=new">
                <span>2</span>
                Create a Virtual Model
              </a>
            </li>
            <li>
              <a href="/agents?agentDialog=new">
                <span>3</span>
                Create an Agent
              </a>
            </li>
            <li>
              <a href="/playground">
                <span>4</span>
                Send a test request
              </a>
            </li>
          </ol>
        </section>
      ) : null}
      <div className="stat-grid overview-stat-grid">
        <StatCard
          icon="RQ"
          label="Requests 24h"
          value={formatConsoleCompactCount(usageSummary.requestCount)}
          delta={formatPreviousWindowPercentDelta(
            usageSummary.requestCount,
            previousKpis.requestCount,
          )}
          deltaTone={formatDeltaTone(
            usageSummary.requestCount,
            previousKpis.requestCount,
            "up-good",
          )}
        />
        <StatCard
          icon="$"
          label="Cost 24h"
          value={formatConsoleUsd(usageSummary.totalCostUsd)}
          delta={formatPreviousWindowPercentDelta(
            Number(usageSummary.totalCostUsd ?? 0),
            Number(previousKpis.totalCostUsd ?? 0),
          )}
          deltaTone={formatDeltaTone(
            Number(usageSummary.totalCostUsd ?? 0),
            Number(previousKpis.totalCostUsd ?? 0),
            "down-good",
          )}
        />
        <StatCard
          icon="TK"
          label="Tokens 24h"
          value={formatConsoleCompactCount(usageSummary.totalTokens)}
          delta={formatPreviousWindowPercentDelta(
            usageSummary.totalTokens,
            previousKpis.totalTokens,
          )}
          deltaTone={formatDeltaTone(usageSummary.totalTokens, previousKpis.totalTokens, "up-good")}
        />
        <StatCard
          icon="FR"
          label="Failure rate"
          value={failureRate}
          valueTone={failureRateTone(usageSummary.failureCount, usageSummary.requestCount)}
          delta={formatPreviousWindowPointDelta(
            usageSummary.requestCount > 0
              ? usageSummary.failureCount / usageSummary.requestCount
              : 0,
            previousKpis.failureRate,
          )}
          deltaTone={formatDeltaTone(
            usageSummary.requestCount > 0
              ? usageSummary.failureCount / usageSummary.requestCount
              : 0,
            previousKpis.failureRate,
            "down-good",
          )}
        />
        <StatCard icon="AG" label="Active agents 24h" value={String(activeAgentCount)} />
      </div>

      <div className="detail-layout">
        <div className="chart-card">
          <h2 className="chart-card-title">Recent requests</h2>
          {recentActivities.length === 0 ? (
            <p>No activity recorded.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table bounded-table overview-requests-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Agent</th>
                    <th>Virtual model</th>
                    <th>Hit model</th>
                    <th>Provider</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentActivities.map((activity) => (
                    <tr key={activity.id}>
                      <td className="mono">{formatConsoleTimestamp(activity.startedAt)}</td>
                      <td>{activity.agentName ?? "Unknown agent"}</td>
                      <td>{formatActivityVirtualModelLabel(activity)}</td>
                      <td>{formatActivityModelSummary(activity)}</td>
                      <td>{formatActivityProviderLabel(activity)}</td>
                      <td className="num">{formatConsoleCount(activity.totalTokens)}</td>
                      <td className="num">{formatConsoleUsd(activity.totalCostUsd)}</td>
                      <td>
                        <ActivityStatusPill status={activity.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="chart-grid-2">
        <div className="chart-card">
          <h2 className="chart-card-title">Requests &amp; cost trend</h2>
          <TrendLineChart
            ariaLabel="Requests and cost trend"
            emptyMessage="No requests in the last 24h."
            data={trend}
            series={[
              { key: "requests", name: "Requests", color: chartAccent },
              { key: "costUsd", name: "Cost (USD)", color: chartOk },
            ]}
          />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Top agents by cost</h2>
          {topAgents.length === 0 ? (
            <p>No agent activity recorded.</p>
          ) : (
            <DonutBreakdown ariaLabel="Top agents by cost" data={topAgents} valueFormat="usd" />
          )}
        </div>
      </div>
    </section>
  );
}
