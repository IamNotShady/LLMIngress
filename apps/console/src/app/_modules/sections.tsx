import {
  type ConsoleActivity,
  type ConsoleActivityDetail,
  type ConsoleFallbackEvent,
  countConsoleActivities,
  formatConsoleActivityFallbackAttempts,
  formatConsoleActivityMetadata,
  formatConsoleActivityRouteReason,
  getConsoleActivityDetail,
  listConsoleActivities,
} from "@llmingress/db/console-activity";
import {
  type ConsoleAgentLimit,
  type ConsoleAgentLimitRuntimeSnapshot,
  defaultAgentLimitFormValues,
  formatAgentLimitSummaries,
  listAgentLimitRuntimeSnapshots,
  listAgentLimits,
} from "@llmingress/db/console-agent-limits";
import {
  type AgentDerivedStatus,
  type AgentIntegrationPlatform,
  type AgentType,
  type AgentVirtualModelAccess,
  agentIntegrationPlatforms,
  type ConsoleAgent,
  listAgents,
  listAgentVirtualModelAccess,
} from "@llmingress/db/console-agents";
import { getConsoleAnalyticsSnapshot } from "@llmingress/db/console-analytics";
import { getConsoleSecuritySummary } from "@llmingress/db/console-auth";
import {
  formatConsoleCompactCount,
  formatConsoleCount,
  formatConsoleTimestamp,
  formatConsoleUsd,
  MISSING_VALUE,
} from "@llmingress/db/console-format";
import {
  type ConsoleNotificationChannel,
  listNotificationChannels,
} from "@llmingress/db/console-notification-channels";
import {
  type ConsoleProviderHealthSummary,
  listConsoleProviderHealthSummaries,
} from "@llmingress/db/console-provider-health";
import {
  listProviderApiKeyMetadata,
  type ProviderApiKeyMetadata,
} from "@llmingress/db/console-provider-keys";
import { listConsoleProviderOAuthConnections } from "@llmingress/db/console-provider-oauth";
import { listProviderTemplateSelectorGroups } from "@llmingress/db/console-provider-templates";
import { type ConsoleProvider, listProviders } from "@llmingress/db/console-providers";
import {
  buildRoutePolicyHealthWarnings,
  type ConsoleProviderModelOption,
  type ConsoleRoutePolicy,
  filterRoutePolicyEditorHealthyProviderModelOptions,
  filterRoutePolicyEditorProviderModelOptions,
  listProviderModelOptions,
  listRoutePolicies,
  mergeRoutePolicyEditorProviderModelOptions,
  normalizeRoutePolicyEditorFilters,
  routePolicyStrategies,
} from "@llmingress/db/console-route-policies";
import {
  formatGatewayConfigVersion,
  formatGatewayHeartbeatStatus,
  formatRuntimeReloadResult,
  getConsoleRuntimeSnapshot,
} from "@llmingress/db/console-runtime";
import {
  type ConsoleUsageDimensionBreakdown,
  type ConsoleUsageTrendPoint,
  type ConsoleUsageWindow,
  getConsoleUsageSummary,
  parseConsoleUsageWindow,
} from "@llmingress/db/console-usage";
import {
  type ConsoleVirtualModel,
  listVirtualModelFallbackBreakdown,
  listVirtualModels,
} from "@llmingress/db/console-virtual-models";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { chartAccent, chartOk } from "../_components/charts/palette";
import { TrendLineChart } from "../_components/charts/trend-line-chart";
import { FlatIcon } from "../_components/flat-icon";
import { Disclosure, Pager, Row } from "../_components/list-ui";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref, PAGE_SIZE, paginate, readPageParam } from "../_lib/pagination";
import { ProviderCreateForm } from "./provider-create-form";
import { ProvidersClientSection } from "./providers-client-section";
import { VirtualModelRouteDialogClient } from "./virtual-model-route-dialog";

export type ConsoleSearchParams = Record<string, string | string[] | undefined>;

const providerTemplateGroups = listProviderTemplateSelectorGroups();
const usageTrendActualColor = "var(--chart-3)";
const usageTrendBaselineColor = "var(--chart-2)";
const usageTrendTokenColor = "var(--chart-4)";
const directProviderCreateChoices = [
  {
    action: "create",
    baseUrlMode: "fixed_create",
    displayName: "OpenAI",
    fixedBaseUrl: "https://api.openai.com/v1",
    groupId: "remote_api_key",
    groupLabel: "API Keys",
    id: "openai",
    providerKey: "openai",
    providerType: "api_key",
  },
  {
    action: "create",
    baseUrlMode: "fixed_create",
    displayName: "Anthropic",
    fixedBaseUrl: "https://api.anthropic.com/v1",
    groupId: "remote_api_key",
    groupLabel: "API Keys",
    id: "anthropic",
    providerKey: "anthropic",
    providerType: "api_key",
  },
] as const;
const defaultProviderCreateChoice = directProviderCreateChoices[0];
const providerCreateChoices = [
  ...directProviderCreateChoices,
  ...providerTemplateGroups.flatMap((group) =>
    group.templates.map((template) => ({
      action: "createFromTemplate",
      baseUrlMode: template.baseUrlMode,
      baseUrlPlaceholder: template.baseUrlPlaceholder,
      displayName: template.displayName,
      fixedBaseUrl: template.fixedBaseUrl,
      groupId: group.id,
      groupLabel: group.label,
      id: template.id,
      providerKey: template.providerKey,
      providerType: template.providerType,
    })),
  ),
];

export async function OverviewSection() {
  const now = new Date();
  const overviewStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const usageSummary = await getConsoleUsageSummary({ window: "24h" });
  const overviewAnalytics = await getConsoleAnalyticsSnapshot({
    bucket: "hour",
    end: now,
    start: overviewStart,
    topLimit: 20,
  });
  const activities = await listConsoleActivities();

  const recentActivities = activities.slice(0, 8);
  const activeAgentCount = usageSummary.agentBreakdowns.filter(
    (agent) => agent.requestCount > 0,
  ).length;
  const failureRate =
    usageSummary.requestCount > 0
      ? `${((usageSummary.failureCount / usageSummary.requestCount) * 100).toFixed(2)}%`
      : "0.00%";
  const trend = usageSummary.trend.map(formatOverviewTrendPoint);
  const topAgents = buildTopAgentsByCost(usageSummary.agentBreakdowns, recentActivities);

  return (
    <section className="overview-dashboard" aria-label="Overview">
      <div className="stat-grid overview-stat-grid">
        <StatCard
          icon="RQ"
          label="Requests 24h"
          value={formatConsoleCompactCount(usageSummary.requestCount)}
          delta={formatPreviousWindowPercentDelta(
            usageSummary.requestCount,
            overviewAnalytics.previous.requestCount,
          )}
          deltaTone={formatDeltaTone(
            usageSummary.requestCount,
            overviewAnalytics.previous.requestCount,
            "up-good",
          )}
        />
        <StatCard
          icon="$"
          label="Cost 24h"
          value={formatConsoleUsd(usageSummary.totalCostUsd)}
          delta={formatPreviousWindowPercentDelta(
            Number(usageSummary.totalCostUsd ?? 0),
            Number(overviewAnalytics.previous.totalCostUsd ?? 0),
          )}
          deltaTone={formatDeltaTone(
            Number(usageSummary.totalCostUsd ?? 0),
            Number(overviewAnalytics.previous.totalCostUsd ?? 0),
            "down-good",
          )}
        />
        <StatCard
          icon="TK"
          label="Tokens 24h"
          value={formatConsoleCompactCount(usageSummary.totalTokens)}
          delta={formatPreviousWindowPercentDelta(
            usageSummary.totalTokens,
            overviewAnalytics.previous.totalTokens,
          )}
          deltaTone={formatDeltaTone(
            usageSummary.totalTokens,
            overviewAnalytics.previous.totalTokens,
            "up-good",
          )}
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
            overviewAnalytics.previous.failureRate,
          )}
          deltaTone={formatDeltaTone(
            usageSummary.requestCount > 0
              ? usageSummary.failureCount / usageSummary.requestCount
              : 0,
            overviewAnalytics.previous.failureRate,
            "down-good",
          )}
        />
        <StatCard
          icon="SV"
          label="Savings"
          value={formatConsoleUsd(usageSummary.totalSavingsUsd)}
          delta={formatPreviousWindowPercentDelta(
            Number(usageSummary.totalSavingsUsd ?? 0),
            Number(overviewAnalytics.previous.totalSavingsUsd ?? 0),
          )}
          deltaTone={formatDeltaTone(
            Number(usageSummary.totalSavingsUsd ?? 0),
            Number(overviewAnalytics.previous.totalSavingsUsd ?? 0),
            "up-good",
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
              <table className="data-table">
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

// Valence per metric: callers say which direction is good (cost down is good,
// requests up is good). Zero change is neutral, never tinted.
function formatDeltaTone(
  current: number,
  previous: number,
  direction: "up-good" | "down-good",
): "good" | "bad" | "neutral" {
  if (current === previous) {
    return "neutral";
  }
  return current > previous === (direction === "up-good") ? "good" : "bad";
}

// Alert thresholds for failure rates: 5% warns, 20% is dangerous.
function failureRateTone(
  failureCount: number,
  requestCount: number,
): "danger" | "warn" | undefined {
  if (requestCount <= 0) {
    return undefined;
  }
  const rate = failureCount / requestCount;
  if (rate >= 0.2) {
    return "danger";
  }
  if (rate >= 0.05) {
    return "warn";
  }
  return undefined;
}

function toneToNumClass(tone: "danger" | "warn" | undefined): string | undefined {
  return tone ? `num-${tone}` : undefined;
}

function formatActivityLatency(latencyMs: number | null): string {
  if (latencyMs === null) {
    return "—";
  }
  return `${(latencyMs / 1000).toFixed(2)}s`;
}

function buildTopAgentsByCost(
  agentBreakdowns: ConsoleUsageDimensionBreakdown[],
  recentActivities: ConsoleActivity[],
) {
  const fromUsage = agentBreakdowns
    .map((breakdown) => ({
      name: breakdown.label,
      value: Number(breakdown.totalCostUsd ?? 0),
    }))
    .filter((breakdown) => breakdown.value > 0);
  if (fromUsage.length > 0) {
    return fromUsage.sort((left, right) => right.value - left.value).slice(0, 5);
  }

  const recentCosts = new Map<string, number>();
  for (const activity of recentActivities) {
    const value = Number(activity.totalCostUsd ?? 0);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const label = activity.agentName ?? "Unknown agent";
    recentCosts.set(label, (recentCosts.get(label) ?? 0) + value);
  }
  return Array.from(recentCosts, ([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 5);
}

function formatActivityVirtualModelLabel(activity: ConsoleActivity): string {
  if (activity.virtualModelDisplayName && activity.virtualModelName) {
    return activity.virtualModelName;
  }
  return activity.virtualModelName ?? activity.model ?? "Unknown virtual model";
}

function ActivityStatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") {
    return <span className="pill--ok pill">Success</span>;
  }
  if (normalized === "error" || normalized === "failed" || normalized === "failure") {
    return <span className="pill--danger pill">Failed</span>;
  }
  return <span className="pill">{status}</span>;
}

const runtimeSecurityNotes = [
  "Provider API keys are encrypted with AES-256-GCM and decrypted only in memory.",
  "Agent API keys are stored as a hash; the full key is shown once at creation.",
  "Gateway runtime config is applied from the deployed config version; the Console cannot restart processes.",
  "This page is read-only runtime status — it does not change any stored settings.",
];

export async function RuntimeSection() {
  const runtimeSnapshot = await getConsoleRuntimeSnapshot();
  const gateway = runtimeSnapshot.gateways[0] ?? null;

  return (
    <section className="providers-panel" id="runtime" aria-labelledby="runtime-title">
      <h2 className="sr-only" id="runtime-title">
        Gateway Runtime
      </h2>
      <div className="stat-grid">
        <StatCard
          icon="ST"
          label="Gateway status"
          value={gateway ? gateway.status : "No gateway"}
        />
        <StatCard icon="URL" label="Configured Gateway URL" value={getPlaygroundGatewayBaseUrl()} />
        <StatCard
          icon="CV"
          label="Config version"
          value={formatGatewayConfigVersion(gateway?.appliedConfigVersion ?? null)}
        />
        <StatCard
          icon="HB"
          label="Heartbeat"
          value={gateway ? formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt }) : "—"}
          valueTone={
            gateway &&
            formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt }) !== "Healthy"
              ? "warn"
              : undefined
          }
        />
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Gateway internal errors</h3>
        {runtimeSnapshot.errors.length === 0 ? (
          <p>No gateway internal errors recorded.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Code</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {runtimeSnapshot.errors.map((error) => (
                  <tr
                    key={`${error.processType}:${error.processId}:${error.errorCode}:${error.createdAt.toISOString()}`}
                  >
                    <td>{formatDateTime(error.createdAt)}</td>
                    <td>{error.processType}</td>
                    <td className="mono">{error.errorCode}</td>
                    <td>{error.errorMessage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Migration status</h3>
        <dl className="detail-field-list">
          <div className="detail-field">
            <dt>Current schema</dt>
            <dd>{runtimeSnapshot.migrations.currentSchemaVersion ?? "not initialized"}</dd>
          </div>
          <div className="detail-field">
            <dt>Applied migrations</dt>
            <dd>
              {runtimeSnapshot.migrations.appliedCount}/{runtimeSnapshot.migrations.totalCount}
            </dd>
          </div>
          <div className="detail-field">
            <dt>Pending migrations</dt>
            <dd>
              {runtimeSnapshot.migrations.pendingMigrations.length === 0
                ? "none"
                : runtimeSnapshot.migrations.pendingMigrations
                    .map((migration) => `${migration.id}_${migration.name}`)
                    .join(", ")}
            </dd>
          </div>
          <div className="detail-field">
            <dt>db:migrate:check</dt>
            <dd>
              {runtimeSnapshot.migrations.migrateCheckHealth.status === "ready" ? (
                <span className="pill--ok pill">Ready</span>
              ) : (
                <span className="pill--danger pill">Blocked</span>
              )}
            </dd>
          </div>
          {gateway ? (
            <>
              <div className="detail-field">
                <dt>Applied config</dt>
                <dd>{formatConfigVersion(gateway.appliedConfigVersion)}</dd>
              </div>
              <div className="detail-field">
                <dt>Target config</dt>
                <dd>{formatConfigVersion(gateway.targetConfigVersion)}</dd>
              </div>
              <div className="detail-field">
                <dt>Config reload</dt>
                <dd>{formatRuntimeReloadResult(gateway)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Security</h3>
        <ul className="note-list">
          {runtimeSecurityNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
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

export async function ActivitySection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const page = readPageParam(searchParams);
  const selectedActivityId = readSingleSearchParam(searchParams.activityId);
  const activityRange = parseActivityRange(readSingleSearchParam(searchParams.activityRange));
  const filters = {
    agentApiKeyId: readSingleSearchParam(searchParams.agentId),
    from: getActivityWindowStart(new Date(), activityRange),
    providerId: readSingleSearchParam(searchParams.providerId),
    requestIdQuery: readSingleSearchParam(searchParams.q),
    status: readSingleSearchParam(searchParams.status),
    virtualModelId: readSingleSearchParam(searchParams.virtualModelId),
  };
  const [agents, virtualModels, providers, total, activities] = await Promise.all([
    listAgents(),
    listVirtualModels(),
    listProviders(),
    countConsoleActivities({ filters }),
    listConsoleActivities({ filters, limit: PAGE_SIZE, page }),
  ]);
  const selectedListActivity = selectedActivityId
    ? (activities.find((activity) => activity.id === selectedActivityId) ?? null)
    : null;
  const selectedDetail = selectedListActivity
    ? await getConsoleActivityDetail({ activityId: selectedListActivity.id })
    : null;
  const selectedActivity = selectedDetail?.activity ?? selectedListActivity;
  const activityDetailCloseHref = buildQueryHref(searchParams, { activityId: undefined });
  const view = {
    from: total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1,
    items: activities,
    page,
    to: total === 0 ? 0 : (page - 1) * PAGE_SIZE + activities.length,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };

  return (
    <section className="activity-workspace" id="activity" aria-label="Activity">
      <form className="activity-filter-grid" action="/activity" method="get">
        <div className="console-field">
          <label htmlFor="activity-agent">Agent</label>
          <select id="activity-agent" name="agentId" defaultValue={filters.agentApiKeyId ?? ""}>
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        <div className="console-field">
          <label htmlFor="activity-virtual-model">Virtual Model</label>
          <select
            id="activity-virtual-model"
            name="virtualModelId"
            defaultValue={filters.virtualModelId ?? ""}
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
          <label htmlFor="activity-provider">Provider</label>
          <select id="activity-provider" name="providerId" defaultValue={filters.providerId ?? ""}>
            <option value="">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="console-field">
          <label htmlFor="activity-status">Status</label>
          <select id="activity-status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">All statuses</option>
            <option value="succeeded">Success</option>
            <option value="failed">Failed</option>
            <option value="started">Started</option>
            <option value="canceled">Canceled</option>
          </select>
        </div>
        <div className="console-field">
          <label htmlFor="activity-range">Time range</label>
          <select id="activity-range" name="activityRange" defaultValue={activityRange}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
        <div className="console-field activity-request-filter">
          <label htmlFor="activity-q">Request ID</label>
          <input
            id="activity-q"
            name="q"
            defaultValue={filters.requestIdQuery ?? ""}
            placeholder="req_..."
          />
        </div>
        <div className="console-actions">
          <button type="submit">
            <span>Filter</span>
          </button>
        </div>
      </form>

      <div className="activity-shell">
        <div className="activity-table-region">
          <h2 className="activity-region-title">Request list</h2>
          <div className="data-table-wrap activity-table-wrap">
            <table className="data-table activity-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Request ID</th>
                  <th>Agent</th>
                  <th>Virtual Model</th>
                  <th>Provider / Model</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num">Latency</th>
                  <th>Status</th>
                  <th className="num">Fallbacks</th>
                </tr>
              </thead>
              <tbody>
                {activities.length === 0 ? (
                  <tr>
                    <td colSpan={10}>No requests match the filters.</td>
                  </tr>
                ) : (
                  activities.map((activity) => (
                    <tr
                      key={activity.id}
                      className={
                        selectedActivity?.id === activity.id ? "is-selected" : "is-clickable"
                      }
                    >
                      <td className="mono">{formatConsoleTimestamp(activity.startedAt)}</td>
                      <td className="mono">
                        <a href={buildQueryHref(searchParams, { activityId: activity.id })}>
                          {activity.requestId}
                        </a>
                      </td>
                      <td>{activity.agentName ?? "Unknown agent"}</td>
                      <td>{formatActivityVirtualModelLabel(activity)}</td>
                      <td>{formatActivityProviderModelLabel(activity)}</td>
                      <td className="num">{formatConsoleCount(activity.totalTokens)}</td>
                      <td className="num">{formatConsoleUsd(activity.totalCostUsd)}</td>
                      <td className="num">{formatActivityLatency(activity.latencyMs)}</td>
                      <td>
                        <ActivityStatusPill status={activity.status} />
                      </td>
                      <td className="num">{formatConsoleCount(activityFallbackCount(activity))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager view={view} searchParams={searchParams} />
        </div>
      </div>

      {selectedActivity ? (
        <ActivityReferenceDetail
          closeHref={activityDetailCloseHref}
          detail={selectedDetail}
          fallbackActivity={selectedActivity}
        />
      ) : null}
    </section>
  );
}

function ActivityReferenceDetail({
  closeHref,
  detail,
  fallbackActivity,
}: {
  closeHref: string;
  detail: ConsoleActivityDetail | null;
  fallbackActivity: ConsoleActivity;
}) {
  const activity = detail?.activity ?? fallbackActivity;
  const metadataLines = buildActivityMetadataLines(activity, detail?.requestMetadata ?? {});
  const fallbackEvents = detail?.fallbackEvents ?? [];
  const fallbackAttemptLines = formatConsoleActivityFallbackAttempts(activity.fallbackAttempts);

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-label="Request detail"
        aria-labelledby="activity-detail-title"
        aria-modal="true"
        className="console-dialog activity-detail-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <div className="agent-view-dialog-title">
            <h2 id="activity-detail-title">Request detail</h2>
            <ActivityStatusPill status={activity.status} />
          </div>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>

        <dl className="detail-field-list activity-detail-fields">
          <div className="detail-field">
            <dt>Request ID</dt>
            <dd>{activity.requestId}</dd>
          </div>
          <div className="detail-field">
            <dt>Agent</dt>
            <dd>{activity.agentName ?? "Unknown agent"}</dd>
          </div>
          <div className="detail-field">
            <dt>API Key Prefix</dt>
            <dd>{activity.agentKeyPrefix ?? "Unknown"}</dd>
          </div>
          <div className="detail-field">
            <dt>Virtual Model</dt>
            <dd>{formatActivityVirtualModelLabel(activity)}</dd>
          </div>
          <div className="detail-field">
            <dt>Provider / Model</dt>
            <dd>{formatActivityProviderModelLabel(activity)}</dd>
          </div>
          <div className="detail-field">
            <dt>Strategy</dt>
            <dd>{formatRouteReasonStrategy(activity.routeReason)}</dd>
          </div>
          <div className="detail-field detail-field-wide">
            <dt>Route reason</dt>
            <dd>{formatConsoleActivityRouteReason(activity.routeReason)}</dd>
          </div>
        </dl>

        <div>
          <p className="detail-section-label">Fallback timeline</p>
          {fallbackEvents.length === 0 ? (
            <ul className="activity-legacy-timeline">
              {fallbackAttemptLines.map((attempt) => (
                <li key={attempt}>{attempt}</li>
              ))}
            </ul>
          ) : (
            <ol className="activity-timeline">
              {fallbackEvents.map((event) => (
                <li key={`${event.attemptOrder}:${event.status}`}>
                  <span className={activityTimelineStepClass(event.status)}>
                    {event.attemptOrder}
                  </span>
                  <span>
                    <strong>{formatFallbackEventModel(event)}</strong>
                    <em>{formatFallbackEventResult(event)}</em>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="activity-metric-grid">
          <div>
            <span>Tokens</span>
            <strong>{formatConsoleCount(activity.totalTokens)}</strong>
          </div>
          <div>
            <span>Cost</span>
            <strong>{formatConsoleUsd(activity.totalCostUsd)}</strong>
          </div>
          <div>
            <span>Latency</span>
            <strong>{formatActivityLatency(activity.latencyMs)}</strong>
          </div>
        </div>

        {activity.errorMessage || activity.errorCode ? (
          <div>
            <p className="detail-section-label">Error info</p>
            <p className="callout callout--warn">{formatActivityError(activity)}</p>
          </div>
        ) : null}

        <div>
          <p className="detail-section-label">Request metadata</p>
          <pre className="code-block activity-metadata-block">{metadataLines.join("\n")}</pre>
          <p className="callout">Prompt / response bodies are not stored.</p>
        </div>
      </section>
    </>
  );
}

export async function VirtualModelsSection({
  searchParams,
}: {
  searchParams: ConsoleSearchParams;
}) {
  const virtualModels = await listVirtualModels();
  const routePolicies = await listRoutePolicies();
  const providerHealthSummaries = await listConsoleProviderHealthSummaries();
  const providerHealthByProviderId = new Map(
    providerHealthSummaries.map((summary) => [summary.id, summary]),
  );
  const providerModelOptions = orderProviderModelsForConsole(
    filterRoutePolicyEditorHealthyProviderModelOptions(
      await listProviderModelOptions(),
      providerHealthSummaries,
    ),
  );
  const routePolicyByVmId = new Map(routePolicies.map((policy) => [policy.virtualModelId, policy]));
  const statusFilter = readSingleSearchParam(searchParams.vmStatus) ?? "";
  const strategyFilter = readSingleSearchParam(searchParams.vmStrategy) ?? "";
  const queryFilter = readSingleSearchParam(searchParams.vmQuery)?.toLowerCase() ?? "";
  const visibleVirtualModels = virtualModels.filter((virtualModel) => {
    const policy = routePolicyByVmId.get(virtualModel.id);
    if (statusFilter === "enabled" && !virtualModel.enabled) {
      return false;
    }
    if (statusFilter === "disabled" && virtualModel.enabled) {
      return false;
    }
    if (strategyFilter && policy?.strategy !== strategyFilter) {
      return false;
    }
    if (
      queryFilter &&
      ![virtualModel.name, virtualModel.description].some((value) =>
        value.toLowerCase().includes(queryFilter),
      )
    ) {
      return false;
    }
    return true;
  });
  const viewVirtualModelId = readSingleSearchParam(searchParams.virtualModelView);
  const viewDialogVirtualModel = viewVirtualModelId
    ? (virtualModels.find((virtualModel) => virtualModel.id === viewVirtualModelId) ?? null)
    : null;
  const viewDialogRoutePolicy = viewDialogVirtualModel
    ? (routePolicyByVmId.get(viewDialogVirtualModel.id) ?? null)
    : null;
  const viewDialogRoutePolicyWarnings = viewDialogRoutePolicy
    ? [
        ...viewDialogRoutePolicy.routeWarnings,
        ...buildRoutePolicyHealthWarnings(
          buildRoutePolicyHealthWarningCandidates(
            viewDialogRoutePolicy,
            providerHealthByProviderId,
          ),
        ),
      ]
    : [];
  const viewDialogCloseHref = buildQueryHref(searchParams, {
    selected: undefined,
    virtualModelView: undefined,
  });
  const dialogTarget = readSingleSearchParam(searchParams.virtualModelDialog);
  const dialogVirtualModel =
    dialogTarget && dialogTarget !== "new"
      ? (virtualModels.find((virtualModel) => virtualModel.id === dialogTarget) ?? null)
      : null;
  const dialogRoutePolicy = dialogVirtualModel
    ? (routePolicyByVmId.get(dialogVirtualModel.id) ?? null)
    : null;
  const dialogCloseHref = buildQueryHref(searchParams, { virtualModelDialog: undefined });
  const totalVirtualModelRequests24h = virtualModels.reduce(
    (total, virtualModel) => total + virtualModel.requestCount24h,
    0,
  );
  const totalVirtualModelCost24h = virtualModels.reduce(
    (total, virtualModel) => total + parseUsd(virtualModel.cost24hUsd),
    0,
  );
  const totalVirtualModelFailures = virtualModels.reduce(
    (total, virtualModel) => total + virtualModel.failureCountTotal,
    0,
  );
  const totalVirtualModelRequests = virtualModels.reduce(
    (total, virtualModel) => total + virtualModel.requestCountTotal,
    0,
  );
  const viewDialogFallbackOverview = viewDialogVirtualModel
    ? await listVirtualModelFallbackBreakdown({
        virtualModelId: viewDialogVirtualModel.id,
      })
    : [];
  return (
    <section className="vm-dashboard" aria-label="Virtual models and routes">
      <div className="stat-grid">
        <StatCard icon="VM" label="Virtual Models" value={String(virtualModels.length)} />
        <StatCard
          icon="Q"
          label="Requests 24h"
          value={formatConsoleCompactCount(totalVirtualModelRequests24h)}
        />
        <StatCard
          icon="$"
          label="Cost 24h"
          value={formatVirtualModelCost(totalVirtualModelCost24h)}
        />
        <StatCard
          icon="!"
          label="Avg failure rate"
          value={formatVirtualModelFailureRate(
            totalVirtualModelRequests,
            totalVirtualModelFailures,
            2,
          )}
          valueTone={failureRateTone(totalVirtualModelFailures, totalVirtualModelRequests)}
        />
      </div>
      <form className="vm-filter-bar" action="/models" method="get">
        <div>
          <label htmlFor="vm-status-filter">Status</label>
          <select id="vm-status-filter" name="vmStatus" defaultValue={statusFilter}>
            <option value="">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <div>
          <label htmlFor="vm-strategy-filter">Strategy</label>
          <select id="vm-strategy-filter" name="vmStrategy" defaultValue={strategyFilter}>
            <option value="">All</option>
            {routePolicyStrategies.map((strategy) => (
              <option key={strategy} value={strategy}>
                {formatRouteStrategyLabel(strategy)}
              </option>
            ))}
          </select>
        </div>
        <input
          aria-label="Search Virtual Model Name"
          name="vmQuery"
          placeholder="Search Virtual Model name"
          defaultValue={readSingleSearchParam(searchParams.vmQuery) ?? ""}
        />
        <button type="submit">
          <span>Filter</span>
        </button>
      </form>
      <div className="vm-shell">
        <div className="agents-main-column">
          <div className="chart-card">
            <h2 className="chart-card-title">Virtual Model list</h2>
            {visibleVirtualModels.length === 0 ? (
              <p>No virtual models configured.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table vm-table">
                  <thead>
                    <tr>
                      <th>Virtual Model</th>
                      <th>Strategy</th>
                      <th className="num">Candidates</th>
                      <th>Default hit model</th>
                      <th className="num">Requests 24h</th>
                      <th className="num">Cost 24h</th>
                      <th className="num">Failure rate</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVirtualModels.map((virtualModel) => {
                      const policy = routePolicyByVmId.get(virtualModel.id);
                      const viewHref = buildQueryHref(searchParams, {
                        selected: undefined,
                        virtualModelDialog: undefined,
                        virtualModelView: virtualModel.id,
                      });
                      const selected = virtualModel.id === viewDialogVirtualModel?.id;
                      return (
                        <tr
                          className={selected ? "is-selected" : "is-clickable"}
                          key={virtualModel.id}
                        >
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {virtualModel.name}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {policy ? (
                                <span className="pill--info pill">
                                  {formatRouteStrategyLabel(policy.strategy)}
                                </span>
                              ) : (
                                MISSING_VALUE
                              )}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              {policy?.candidates.length ?? 0}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {formatDefaultCandidate(policy)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              {formatConsoleCompactCount(virtualModel.requestCount24h)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              {formatVirtualModelCost(virtualModel.cost24hUsd)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={viewHref}>
                              <span
                                className={toneToNumClass(
                                  failureRateTone(
                                    virtualModel.failureCountTotal,
                                    virtualModel.requestCountTotal,
                                  ),
                                )}
                              >
                                {formatVirtualModelFailureRate(
                                  virtualModel.requestCountTotal,
                                  virtualModel.failureCountTotal,
                                )}
                              </span>
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={viewHref}>
                              {virtualModel.enabled ? (
                                <span className="pill--ok pill">Enabled</span>
                              ) : (
                                <span className="pill">Disabled</span>
                              )}
                            </a>
                          </td>
                          <td>
                            <span className="agent-table-actions">
                              <a
                                className="link-button agent-action-edit"
                                href={buildQueryHref(searchParams, {
                                  virtualModelView: undefined,
                                  virtualModelDialog: virtualModel.id,
                                })}
                              >
                                <FlatIcon name="edit" />
                                <span>Edit</span>
                              </a>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {viewDialogVirtualModel ? (
        <VirtualModelViewDialog
          closeHref={viewDialogCloseHref}
          fallbackOverview={viewDialogFallbackOverview}
          routePolicy={viewDialogRoutePolicy}
          routePolicyWarnings={viewDialogRoutePolicyWarnings}
          virtualModel={viewDialogVirtualModel}
        />
      ) : null}
      {dialogTarget === "new" ? (
        <VirtualModelRouteDialog
          closeHref={dialogCloseHref}
          mode="create"
          providerModelOptions={providerModelOptions}
          routePolicy={null}
          virtualModel={null}
        />
      ) : dialogVirtualModel ? (
        <VirtualModelRouteDialog
          closeHref={dialogCloseHref}
          mode="edit"
          providerModelOptions={providerModelOptions}
          routePolicy={dialogRoutePolicy}
          virtualModel={dialogVirtualModel}
        />
      ) : null}
    </section>
  );
}

function VirtualModelViewDialog({
  closeHref,
  fallbackOverview,
  routePolicy,
  routePolicyWarnings,
  virtualModel,
}: {
  closeHref: string;
  fallbackOverview: Awaited<ReturnType<typeof listVirtualModelFallbackBreakdown>>;
  routePolicy: ConsoleRoutePolicy | null;
  routePolicyWarnings: readonly string[];
  virtualModel: ConsoleVirtualModel;
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby={`virtual-model-view-dialog-title-${virtualModel.id}`}
        aria-modal="true"
        className="console-dialog agent-view-dialog vm-view-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <div className="agent-view-dialog-title">
            <h2 id={`virtual-model-view-dialog-title-${virtualModel.id}`}>{virtualModel.name}</h2>
            {virtualModel.enabled ? (
              <span className="pill--ok pill">Enabled</span>
            ) : (
              <span className="pill">Disabled</span>
            )}
          </div>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <dl className="agent-detail-fields">
          <div>
            <dt>Strategy</dt>
            <dd>{routePolicy ? formatRouteStrategyLabel(routePolicy.strategy) : MISSING_VALUE}</dd>
          </div>
          <div>
            <dt>Candidates</dt>
            <dd>{routePolicy ? `${routePolicy.candidates.length} models` : MISSING_VALUE}</dd>
          </div>
          <div>
            <dt>Default hit</dt>
            <dd>{formatDefaultCandidate(routePolicy)}</dd>
          </div>
          <div>
            <dt>Requests 24h</dt>
            <dd>{formatConsoleCompactCount(virtualModel.requestCount24h)}</dd>
          </div>
          <div>
            <dt>Cost 24h</dt>
            <dd>{formatVirtualModelCost(virtualModel.cost24hUsd)}</dd>
          </div>
          <div>
            <dt>Failure rate</dt>
            <dd>
              {formatVirtualModelFailureRate(
                virtualModel.requestCountTotal,
                virtualModel.failureCountTotal,
              )}
            </dd>
          </div>
        </dl>
        <section className="agent-detail-section">
          <h3>Candidates</h3>
          {routePolicy?.candidates.length ? (
            <div className="vm-candidate-list">
              {routePolicy.candidates.map((candidate) => (
                <div className="vm-candidate-card" key={candidate.id}>
                  <div>
                    <strong>
                      {candidate.providerDisplayName} / {candidate.modelDisplayName}
                    </strong>
                    <span>
                      {formatModelPrice(candidate.inputUsdPerMillionTokens)} /{" "}
                      {formatModelPrice(candidate.outputUsdPerMillionTokens)}
                    </span>
                  </div>
                  {candidate.availability === "available" ? (
                    <span className="pill--ok pill">Healthy</span>
                  ) : (
                    <span className="pill">Disabled</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p>No candidates configured.</p>
          )}
        </section>
        {routePolicyWarnings.length > 0 ? (
          <section className="agent-detail-section" aria-label="Route warnings">
            <h3>Route warnings</h3>
            {routePolicyWarnings.map((warning) => (
              <p className="route-warning" key={warning}>
                {warning}
              </p>
            ))}
          </section>
        ) : null}
        <section className="agent-detail-section">
          <h3>Fallback overview</h3>
          {fallbackOverview.length > 0 ? (
            <DonutBreakdown
              ariaLabel="Fallback overview"
              data={fallbackOverview}
              valueFormat="percent"
            />
          ) : (
            <p>No fallback data recorded in the last 24h.</p>
          )}
        </section>
      </section>
    </>
  );
}

function VirtualModelRouteDialog({
  closeHref,
  mode,
  providerModelOptions,
  routePolicy,
  virtualModel,
}: {
  closeHref: string;
  mode: "create" | "edit";
  providerModelOptions: readonly ConsoleProviderModelOption[];
  routePolicy: ConsoleRoutePolicy | null;
  virtualModel: ConsoleVirtualModel | null;
}) {
  return (
    <VirtualModelRouteDialogClient
      closeHref={closeHref}
      mode={mode}
      providerModelOptions={[...providerModelOptions]}
      routePolicy={routePolicy}
      virtualModel={virtualModel}
    />
  );
}

export async function RoutePoliciesSection({
  searchParams,
}: {
  searchParams: ConsoleSearchParams;
}) {
  const routePolicyEditorFilters = normalizeRoutePolicyEditorFilters({
    modelQuery: readSingleSearchParam(searchParams.routeModelFilter),
    providerKey: readSingleSearchParam(searchParams.routeProviderFilter),
  });
  const virtualModels = await listVirtualModels();
  const routePolicies = await listRoutePolicies();
  const providerModelOptions = await listProviderModelOptions();
  const providerHealthSummaries = await listConsoleProviderHealthSummaries();
  const providerHealthByProviderId = new Map(
    providerHealthSummaries.map((summary) => [summary.id, summary]),
  );
  const routePolicyProviderFilterOptions =
    listRoutePolicyProviderFilterOptions(providerModelOptions);
  const routePolicyCreateProviderModelOptions = filterRoutePolicyEditorProviderModelOptions(
    providerModelOptions,
    routePolicyEditorFilters,
  );
  const routedVirtualModelIds = new Set(
    routePolicies.map((routePolicy) => routePolicy.virtualModelId),
  );
  const virtualModelsWithoutRoutePolicy = virtualModels.filter(
    (virtualModel) => !routedVirtualModelIds.has(virtualModel.id),
  );
  const view = paginate(routePolicies, readPageParam(searchParams));
  return (
    <section className="providers-panel" aria-label="Route policies">
      {providerModelOptions.length === 0 ? null : (
        <form className="provider-create-form" action="/routing" method="get">
          <label htmlFor="route-provider-filter">Route provider filter</label>
          <select
            id="route-provider-filter"
            name="routeProviderFilter"
            defaultValue={routePolicyEditorFilters.providerKey ?? ""}
          >
            <option value="">All providers</option>
            {routePolicyProviderFilterOptions.map((provider) => (
              <option key={provider.providerKey} value={provider.providerKey}>
                {provider.providerDisplayName} ({provider.providerKey})
              </option>
            ))}
          </select>
          <label htmlFor="route-model-filter">Route model filter</label>
          <input
            id="route-model-filter"
            name="routeModelFilter"
            defaultValue={routePolicyEditorFilters.modelQuery ?? ""}
          />
          <button type="submit">
            <FlatIcon name="filter" />
            <span>Apply route policy filters</span>
          </button>
          <a href="/routing">Clear route policy filters</a>
        </form>
      )}
      {virtualModelsWithoutRoutePolicy.length === 0 ? (
        <p>No Virtual Models without route policies.</p>
      ) : providerModelOptions.length === 0 ? (
        <p>No provider models available.</p>
      ) : routePolicyCreateProviderModelOptions.length === 0 ? (
        <p>No provider models match route policy filters.</p>
      ) : (
        <Disclosure tone="add" summary="New route policy">
          <form className="provider-create-form" action="/api/route-policies" method="post">
            <input type="hidden" name="action" value="create" />
            <label htmlFor="route-policy-virtual-model">Route policy virtual model</label>
            <select id="route-policy-virtual-model" name="virtualModelId" required defaultValue="">
              <option value="" disabled>
                Select virtual model
              </option>
              {virtualModelsWithoutRoutePolicy.map((virtualModel) => (
                <option key={virtualModel.id} value={virtualModel.id}>
                  {virtualModel.name}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-strategy">Route policy strategy</label>
            <select id="route-policy-strategy" name="strategy" required defaultValue="random">
              {routePolicyStrategies.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {strategy}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-models">Provider models (in priority order)</label>
            <select
              id="route-policy-models"
              name="providerModelIds"
              multiple
              required
              size={providerModelSelectSize(routePolicyCreateProviderModelOptions.length)}
            >
              {routePolicyCreateProviderModelOptions.map((providerModel) => (
                <option key={providerModel.id} value={providerModel.id}>
                  {providerModel.pricedOptionLabel}
                </option>
              ))}
            </select>
            <button type="submit">
              <FlatIcon name="add" />
              <span>Create route policy</span>
            </button>
          </form>
        </Disclosure>
      )}
      {routePolicies.length === 0 ? (
        <p>No route policies configured.</p>
      ) : (
        <div className="row-list">
          {view.items.map((routePolicy) => {
            const routePolicyEditorOptions = mergeRoutePolicyEditorProviderModelOptions(
              routePolicyCreateProviderModelOptions,
              routePolicy.candidates,
            );
            const routePolicyWarnings = [
              ...routePolicy.routeWarnings,
              ...buildRoutePolicyHealthWarnings(
                buildRoutePolicyHealthWarningCandidates(routePolicy, providerHealthByProviderId),
              ),
            ];

            return (
              <Row
                key={routePolicy.id}
                title={<h3 className="row-title">{routePolicy.virtualModelDisplayName}</h3>}
                meta={
                  <span className="row-meta">
                    <span className="mono">{routePolicy.virtualModelName}</span>
                    <span>{routePolicy.strategy}</span>
                    {routePolicyWarnings.length > 0 ? (
                      <span className="row-flag">{routePolicyWarnings.length} warnings</span>
                    ) : null}
                  </span>
                }
                status={<span className="status-enabled">Enabled</span>}
              >
                <p>
                  Virtual Model: {routePolicy.virtualModelDisplayName} (
                  {routePolicy.virtualModelName})
                </p>
                <p>Strategy: {routePolicy.strategy}</p>
                <p>Route reason: {routePolicy.routeReason}</p>
                {routePolicyWarnings.map((warning) => (
                  <p className="route-warning" key={warning}>
                    {warning}
                  </p>
                ))}
                <p>Candidates: {formatRoutePolicyCandidateList(routePolicy.candidates)}</p>
                <p>Candidate order: {formatRoutePolicyCandidateOrder(routePolicy.candidates)}</p>
                <form className="provider-edit-form" action="/api/route-policies" method="post">
                  <input type="hidden" name="action" value="update" />
                  <input type="hidden" name="id" value={routePolicy.id} />
                  <input type="hidden" name="virtualModelId" value={routePolicy.virtualModelId} />
                  <label htmlFor={`route-policy-strategy-${routePolicy.id}`}>
                    Edit route policy strategy
                  </label>
                  <select
                    id={`route-policy-strategy-${routePolicy.id}`}
                    name="strategy"
                    defaultValue={routePolicy.strategy}
                    required
                  >
                    {routePolicyStrategies.map((strategy) => (
                      <option key={strategy} value={strategy}>
                        {strategy}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`route-policy-models-${routePolicy.id}`}>
                    Edit provider models (in priority order)
                  </label>
                  <select
                    id={`route-policy-models-${routePolicy.id}`}
                    name="providerModelIds"
                    defaultValue={routePolicy.candidates.map((candidate) => candidate.id)}
                    multiple
                    required
                    size={providerModelSelectSize(routePolicyEditorOptions.length)}
                  >
                    {routePolicyEditorOptions.map((providerModel) => (
                      <option key={providerModel.id} value={providerModel.id}>
                        {providerModel.pricedOptionLabel}
                      </option>
                    ))}
                  </select>
                  <button type="submit">
                    <FlatIcon name="save" />
                    <span>Save route policy</span>
                  </button>
                </form>
                <div className="row-actions">
                  <form action="/api/route-policies" method="post">
                    <input type="hidden" name="action" value="delete" />
                    <input type="hidden" name="id" value={routePolicy.id} />
                    <button className="secondary-button" type="submit">
                      <FlatIcon name="delete" />
                      <span>Delete route policy</span>
                    </button>
                  </form>
                </div>
              </Row>
            );
          })}
        </div>
      )}
      <Pager view={view} searchParams={searchParams} />
    </section>
  );
}

export async function AgentsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const usageToday = await getConsoleUsageSummary({ window: "24h" });
  const usageWeek = await getConsoleUsageSummary({ window: "7d" });
  const agents = await listAgents();
  const agentVirtualModelAccess = await listAgentVirtualModelAccess();
  const agentLimits = await listAgentLimits();
  const virtualModels = await listVirtualModels();
  const agentVirtualModelAccessByAgentId = new Map(
    agentVirtualModelAccess.map((access) => [access.agentId, access]),
  );
  const agentLimitsByAgentId = groupByAgentId(agentLimits);
  const connectedAgentCount = agents.filter((agent) => agent.hasApiKey).length;
  const usageTodayByAgentId = new Map(usageToday.agentBreakdowns.map((agent) => [agent.id, agent]));
  const agentTypeFilter = readAgentTypeFilter(readSingleSearchParam(searchParams.agentType));
  const agentStatusFilter = readAgentStatusFilter(readSingleSearchParam(searchParams.agentStatus));
  const agentPlatformFilter = readAgentPlatformFilter(
    readSingleSearchParam(searchParams.agentPlatform),
  );
  const agentSearch = readSingleSearchParam(searchParams.agentSearch)?.trim() ?? "";
  const visibleAgents = filterAgents(agents, {
    agentSearch,
    agentStatusFilter,
    agentTypeFilter,
    agentPlatformFilter,
  });
  const selectedAgentId = readSingleSearchParam(searchParams.selected);
  const agentView = readSingleSearchParam(searchParams.agentView);
  const viewDialogAgent = agents.find((agent) => agent.id === agentView) ?? null;
  const viewDialogAccess = viewDialogAgent
    ? (agentVirtualModelAccessByAgentId.get(viewDialogAgent.id) ?? null)
    : null;
  const viewDialogLimits = viewDialogAgent
    ? (agentLimitsByAgentId.get(viewDialogAgent.id) ?? [])
    : [];
  const agentViewCloseHref = buildQueryHref(searchParams, { agentView: undefined });
  const agentDialog = readSingleSearchParam(searchParams.agentDialog);
  const editDialogAgent = agents.find((agent) => agent.id === agentDialog) ?? null;
  const agentDialogCloseHref = buildQueryHref(searchParams, {
    agentDialog: undefined,
    agentView: undefined,
  });
  const deleteAgent = readSingleSearchParam(searchParams.deleteAgent);
  const deleteDialogAgent = agents.find((agent) => agent.id === deleteAgent) ?? null;
  const deleteDialogCloseHref = buildQueryHref(searchParams, {
    agentView: undefined,
    deleteAgent: undefined,
  });

  return (
    <section className="agents-dashboard" aria-label="Agents">
      <div className="agents-shell">
        <div className="agents-main-column">
          <div className="stat-grid agents-stat-grid">
            <StatCard icon="AG" label="Agents" value={String(agents.length)} />
            <StatCard icon="ON" label="Connected" value={String(connectedAgentCount)} />
            <StatCard
              icon="RQ"
              label="Requests 24h"
              value={formatConsoleCompactCount(usageToday.requestCount)}
            />
            <StatCard icon="$" label="Cost 7d" value={formatConsoleUsd(usageWeek.totalCostUsd)} />
          </div>
          <form action="/agents" method="get">
            <fieldset className="agents-filter-bar">
              <legend className="sr-only">Agent filters</legend>
              <div className="console-field">
                <label htmlFor="agent-filter-type">Type</label>
                <select id="agent-filter-type" name="agentType" defaultValue={agentTypeFilter}>
                  <option value="all">All</option>
                  <option value="coding">Coding</option>
                  <option value="terminal">Terminal</option>
                  <option value="ide">IDE</option>
                  <option value="desktop">Desktop</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="console-field">
                <label htmlFor="agent-filter-status">Status</label>
                <select
                  id="agent-filter-status"
                  name="agentStatus"
                  defaultValue={agentStatusFilter}
                >
                  <option value="all">All</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                  <option value="high-risk">High risk</option>
                </select>
              </div>
              <div className="console-field">
                <label htmlFor="agent-filter-platform">Platform</label>
                <select
                  id="agent-filter-platform"
                  name="agentPlatform"
                  defaultValue={agentPlatformFilter}
                >
                  <option value="all">All</option>
                  {agentIntegrationPlatforms.map((platform) => (
                    <option key={platform} value={platform}>
                      {formatAgentIntegrationPlatformLabel(platform)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="console-field agents-search-field">
                <label htmlFor="agent-filter-search" className="sr-only">
                  Search
                </label>
                <input
                  id="agent-filter-search"
                  name="agentSearch"
                  defaultValue={agentSearch}
                  placeholder="Search agent name or note"
                />
              </div>
              <div className="agents-filter-actions">
                <button type="submit">
                  <span>Filter</span>
                </button>
              </div>
            </fieldset>
          </form>
          <div className="chart-card agents-list-card">
            <h2 className="chart-card-title">Agent list</h2>
            {agents.length === 0 ? (
              <p>No agents yet — create one below.</p>
            ) : visibleAgents.length === 0 ? (
              <p>No agents match the selected filters.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table agents-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Type</th>
                      <th>API Key Prefix</th>
                      <th>Default VM</th>
                      <th className="num">Available VM</th>
                      <th className="num">Requests 24h</th>
                      <th className="num">24h Cost</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAgents.map((agent) => {
                      const access = agentVirtualModelAccessByAgentId.get(agent.id);
                      const usage = usageTodayByAgentId.get(agent.id);
                      const agentViewHref = buildQueryHref(searchParams, {
                        agentDialog: undefined,
                        agentView: agent.id,
                        deleteAgent: undefined,
                        selected: agent.id,
                      });
                      const isSelectedAgent =
                        agent.id === selectedAgentId || agent.id === viewDialogAgent?.id;
                      return (
                        <tr
                          className={isSelectedAgent ? "is-selected" : "is-clickable"}
                          key={agent.id}
                        >
                          <td>
                            <a className="table-row-link" href={agentViewHref}>
                              {agent.name}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={agentViewHref}>
                              {formatAgentTypeLabel(agent.agentType)}
                            </a>
                          </td>
                          <td className="mono">
                            <a className="table-row-link" href={agentViewHref}>
                              {agent.keyPrefix
                                ? formatAgentKeyPrefixDisplay(agent.keyPrefix)
                                : "No key"}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={agentViewHref}>
                              {access?.defaultVirtualModel?.name ?? "None"}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={agentViewHref}>
                              {access?.allowedVirtualModels.length ?? 0}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={agentViewHref}>
                              {formatConsoleCompactCount(usage?.requestCount ?? 0)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={agentViewHref}>
                              {formatConsoleUsd(usage?.totalCostUsd ?? null)}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={agentViewHref}>
                              <AgentStatusPill status={agent.status} />
                            </a>
                          </td>
                          <td>
                            <span className="agent-table-actions">
                              <a
                                className="link-button agent-action-edit"
                                href={buildQueryHref(searchParams, {
                                  agentDialog: agent.id,
                                  agentView: undefined,
                                })}
                              >
                                <FlatIcon name="edit" />
                                <span>Edit</span>
                              </a>
                              <a
                                className="link-button agent-action-delete"
                                href={buildQueryHref(searchParams, {
                                  agentDialog: undefined,
                                  agentView: undefined,
                                  deleteAgent: agent.id,
                                })}
                              >
                                <FlatIcon name="delete" />
                                <span>Delete</span>
                              </a>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
      {viewDialogAgent ? (
        <AgentViewDialog
          access={viewDialogAccess}
          agent={viewDialogAgent}
          closeHref={agentViewCloseHref}
          limits={viewDialogLimits}
        />
      ) : null}
      {agentDialog === "new" ? (
        <AgentCreateDialog closeHref={agentDialogCloseHref} virtualModels={virtualModels} />
      ) : null}
      {editDialogAgent ? (
        <AgentEditDialog
          agent={editDialogAgent}
          access={
            agentVirtualModelAccessByAgentId.get(editDialogAgent.id) ?? {
              agentId: editDialogAgent.id,
              allowedVirtualModels: [],
              defaultVirtualModel: null,
            }
          }
          closeHref={agentDialogCloseHref}
          limits={agentLimitsByAgentId.get(editDialogAgent.id) ?? []}
          virtualModels={virtualModels}
        />
      ) : null}
      {deleteDialogAgent ? (
        <AgentDeleteDialog agent={deleteDialogAgent} closeHref={deleteDialogCloseHref} />
      ) : null}
    </section>
  );
}

function AgentViewDialog({
  access,
  agent,
  closeHref,
  limits,
}: {
  access: AgentVirtualModelAccess | null;
  agent: ConsoleAgent;
  closeHref: string;
  limits: readonly ConsoleAgentLimit[];
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tokenLimit = findAgentLimit(limits, "token");
  const tpmLimit = findAgentLimit(limits, "tpm");

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby={`agent-view-dialog-title-${agent.id}`}
        aria-modal="true"
        className="console-dialog agent-view-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <div className="agent-view-dialog-title">
            <h2 id={`agent-view-dialog-title-${agent.id}`}>{agent.name}</h2>
            <AgentStatusPill status={agent.status} />
          </div>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <dl className="agent-detail-fields">
          <div>
            <dt>Type</dt>
            <dd>{formatAgentTypeLabel(agent.agentType)}</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>{formatAgentIntegrationPlatformLabel(agent.integrationPlatform)}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatAgentDetailDate(agent.createdAt)}</dd>
          </div>
          <div>
            <dt>Default model</dt>
            <dd>{access?.defaultVirtualModel?.name ?? "None"}</dd>
          </div>
        </dl>
        <section className="agent-detail-section">
          <h3>Allowed Virtual Models</h3>
          <div className="agent-chip-list">
            {(access?.allowedVirtualModels ?? []).map((virtualModel) => (
              <span className="agent-chip" key={virtualModel.id}>
                {virtualModel.name}
              </span>
            ))}
          </div>
        </section>
        <section className="agent-detail-section">
          <h3>Budget / Limit</h3>
          <div className="agent-limit-row">
            <span>Budget</span>
            <strong>{formatAgentBudgetLimit(budgetLimit)}</strong>
          </div>
          <div className="agent-limit-row">
            <span>RPM</span>
            <strong>{formatAgentNumericLimit(rpmLimit)}</strong>
          </div>
          <div className="agent-limit-row">
            <span>TPM</span>
            <strong>{formatAgentNumericLimit(tpmLimit)}</strong>
          </div>
          <div className="agent-limit-row">
            <span>Token limit</span>
            <strong>{formatAgentTokenLimit(tokenLimit)}</strong>
          </div>
        </section>
      </section>
    </>
  );
}

function AgentCreateDialog({
  closeHref,
  virtualModels,
}: {
  closeHref: string;
  virtualModels: readonly ConsoleVirtualModel[];
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="new-agent-dialog-title"
        aria-modal="true"
        className="console-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id="new-agent-dialog-title">New agent</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <form className="provider-create-form" action="/api/agents" id="new-agent" method="post">
          <input type="hidden" name="action" value="create" />
          <label htmlFor="agent-name">Agent name</label>
          <input id="agent-name" name="name" required />
          <label htmlFor="agent-type">Agent type</label>
          <select id="agent-type" name="agentType" required defaultValue="coding">
            <option value="coding">coding</option>
            <option value="desktop">desktop</option>
            <option value="terminal">terminal</option>
            <option value="ide">ide</option>
            <option value="other">other</option>
          </select>
          <label htmlFor="agent-integration-platform">Integration platform</label>
          <select
            id="agent-integration-platform"
            name="integrationPlatform"
            required
            defaultValue="other"
          >
            {agentIntegrationPlatforms.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </select>
          <label htmlFor="agent-request-logging">Request logging</label>
          <select
            id="agent-request-logging"
            name="requestLoggingEnabled"
            required
            defaultValue="true"
          >
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </select>
          <label htmlFor="agent-allowed-virtual-models">Allowed virtual models</label>
          <select
            id="agent-allowed-virtual-models"
            name="allowedVirtualModelIds"
            multiple
            size={virtualModelSelectSize(virtualModels.length)}
          >
            {virtualModels.map((virtualModel) => (
              <option key={virtualModel.id} value={virtualModel.id}>
                {formatVirtualModelOptionLabel(virtualModel)}
              </option>
            ))}
          </select>
          <label htmlFor="agent-default-virtual-model">Default virtual model</label>
          <select id="agent-default-virtual-model" name="defaultVirtualModelId" defaultValue="">
            <option value="">No default virtual model</option>
            {virtualModels.map((virtualModel) => (
              <option key={virtualModel.id} value={virtualModel.id}>
                {formatVirtualModelOptionLabel(virtualModel)}
              </option>
            ))}
          </select>
          <label className="checkbox-label agent-limit-toggle" htmlFor="agent-enable-limits">
            <input id="agent-enable-limits" name="enableLimits" type="checkbox" value="true" />
            <span>Enable limits</span>
          </label>
          <div className="agent-create-limit-fields">
            <label htmlFor="agent-budget-usd">Budget USD limit</label>
            <input
              id="agent-budget-usd"
              name="budgetUsd"
              type="number"
              min="0.000001"
              step="0.000001"
              defaultValue={defaultAgentLimitFormValues.budgetUsd}
            />
            <label htmlFor="agent-budget-period">Budget period</label>
            <select
              id="agent-budget-period"
              name="budgetPeriod"
              defaultValue={defaultAgentLimitFormValues.budgetPeriod}
            >
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
            <label htmlFor="agent-alert-threshold">Alert threshold (%)</label>
            <input
              id="agent-alert-threshold"
              name="alertThresholdPercent"
              type="number"
              min="1"
              max="100"
              step="1"
              defaultValue={defaultAgentLimitFormValues.alertThresholdPercent}
            />
            <label htmlFor="agent-rpm">RPM limit</label>
            <input
              id="agent-rpm"
              name="rpm"
              type="number"
              min="1"
              step="1"
              defaultValue={defaultAgentLimitFormValues.rpm}
            />
            <label htmlFor="agent-tpm">TPM limit</label>
            <input
              id="agent-tpm"
              name="tpm"
              type="number"
              min="1"
              step="1"
              defaultValue={defaultAgentLimitFormValues.tpm}
            />
            <label htmlFor="agent-concurrency">Concurrency limit</label>
            <input
              id="agent-concurrency"
              name="concurrency"
              type="number"
              min="1"
              step="1"
              defaultValue={defaultAgentLimitFormValues.concurrency}
            />
            <label htmlFor="agent-token-limit">Token limit</label>
            <input
              id="agent-token-limit"
              name="tokenLimit"
              type="number"
              min="1"
              step="1"
              defaultValue={defaultAgentLimitFormValues.tokenLimit}
            />
          </div>
          <button type="submit">
            <span>Create</span>
          </button>
        </form>
      </section>
    </>
  );
}

function AgentEditDialog({
  access,
  agent,
  closeHref,
  limits,
  virtualModels,
}: {
  access: AgentVirtualModelAccess;
  agent: ConsoleAgent;
  closeHref: string;
  limits: readonly ConsoleAgentLimit[];
  virtualModels: readonly ConsoleVirtualModel[];
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const concurrencyLimit = findAgentLimit(limits, "concurrency");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tokenLimit = findAgentLimit(limits, "token");
  const tpmLimit = findAgentLimit(limits, "tpm");
  const alertThresholdPercent = readAgentAlertThresholdPercent(limits);
  const limitsEnabled = limits.length > 0;

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby={`agent-dialog-title-${agent.id}`}
        aria-modal="true"
        className="console-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id={`agent-dialog-title-${agent.id}`}>Edit {agent.name}</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <form className="provider-edit-form" action="/api/agents" method="post">
          <input type="hidden" name="action" value="saveAll" />
          <input type="hidden" name="id" value={agent.id} />
          <label htmlFor={`agent-name-${agent.id}`}>Edit agent name</label>
          <input id={`agent-name-${agent.id}`} name="name" defaultValue={agent.name} required />
          <label htmlFor={`agent-type-${agent.id}`}>Edit agent type</label>
          <select
            id={`agent-type-${agent.id}`}
            name="agentType"
            defaultValue={agent.agentType}
            required
          >
            <option value="coding">coding</option>
            <option value="desktop">desktop</option>
            <option value="terminal">terminal</option>
            <option value="ide">ide</option>
            <option value="other">other</option>
          </select>
          <label htmlFor={`agent-integration-platform-${agent.id}`}>
            Edit integration platform
          </label>
          <select
            id={`agent-integration-platform-${agent.id}`}
            name="integrationPlatform"
            defaultValue={agent.integrationPlatform}
            required
          >
            {agentIntegrationPlatforms.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </select>
          <label htmlFor={`agent-request-logging-${agent.id}`}>Edit request logging</label>
          <select
            id={`agent-request-logging-${agent.id}`}
            name="requestLoggingEnabled"
            defaultValue={String(agent.requestLoggingEnabled)}
            required
          >
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </select>
          <label htmlFor={`agent-allowed-virtual-models-${agent.id}`}>Allowed virtual models</label>
          <select
            defaultValue={access.allowedVirtualModels.map((virtualModel) => virtualModel.id)}
            id={`agent-allowed-virtual-models-${agent.id}`}
            name="allowedVirtualModelIds"
            multiple
            size={virtualModelSelectSize(virtualModels.length)}
          >
            {virtualModels.map((virtualModel) => (
              <option key={virtualModel.id} value={virtualModel.id}>
                {formatVirtualModelOptionLabel(virtualModel)}
              </option>
            ))}
          </select>
          <label htmlFor={`agent-default-virtual-model-${agent.id}`}>Default virtual model</label>
          <select
            id={`agent-default-virtual-model-${agent.id}`}
            name="defaultVirtualModelId"
            defaultValue={access.defaultVirtualModel?.id ?? ""}
          >
            <option value="">No default virtual model</option>
            {virtualModels.map((virtualModel) => (
              <option key={virtualModel.id} value={virtualModel.id}>
                {formatVirtualModelOptionLabel(virtualModel)}
              </option>
            ))}
          </select>
          <label
            className="checkbox-label agent-limit-toggle"
            htmlFor={`agent-enable-limits-${agent.id}`}
          >
            <input
              id={`agent-enable-limits-${agent.id}`}
              name="enableLimits"
              type="checkbox"
              value="true"
              defaultChecked={limitsEnabled}
            />
            <span>Enable limits</span>
          </label>
          <div className="agent-limit-fields">
            <label htmlFor={`agent-budget-usd-${agent.id}`}>Budget USD limit</label>
            <input
              id={`agent-budget-usd-${agent.id}`}
              name="budgetUsd"
              type="number"
              min="0.000001"
              step="0.000001"
              defaultValue={budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd}
              required
            />
            <label htmlFor={`agent-budget-period-${agent.id}`}>Budget period</label>
            <select
              id={`agent-budget-period-${agent.id}`}
              name="budgetPeriod"
              defaultValue={budgetLimit?.period ?? defaultAgentLimitFormValues.budgetPeriod}
              required
            >
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
            <label htmlFor={`agent-alert-threshold-${agent.id}`}>Alert threshold (%)</label>
            <input
              id={`agent-alert-threshold-${agent.id}`}
              name="alertThresholdPercent"
              type="number"
              min="1"
              max="100"
              step="1"
              defaultValue={alertThresholdPercent}
              required
            />
            <label htmlFor={`agent-rpm-${agent.id}`}>RPM limit</label>
            <input
              id={`agent-rpm-${agent.id}`}
              name="rpm"
              type="number"
              min="1"
              step="1"
              defaultValue={rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm}
              required
            />
            <label htmlFor={`agent-tpm-${agent.id}`}>TPM limit</label>
            <input
              id={`agent-tpm-${agent.id}`}
              name="tpm"
              type="number"
              min="1"
              step="1"
              defaultValue={tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm}
              required
            />
            <label htmlFor={`agent-concurrency-${agent.id}`}>Concurrency limit</label>
            <input
              id={`agent-concurrency-${agent.id}`}
              name="concurrency"
              type="number"
              min="1"
              step="1"
              defaultValue={concurrencyLimit?.limitValue ?? defaultAgentLimitFormValues.concurrency}
              required
            />
            <label htmlFor={`agent-token-limit-${agent.id}`}>Token limit</label>
            <input
              id={`agent-token-limit-${agent.id}`}
              name="tokenLimit"
              type="number"
              min="1"
              step="1"
              defaultValue={tokenLimit?.limitValue ?? defaultAgentLimitFormValues.tokenLimit}
              required
            />
          </div>
          <button type="submit">
            <span>Save</span>
          </button>
        </form>
      </section>
    </>
  );
}

function AgentDeleteDialog({ agent, closeHref }: { agent: ConsoleAgent; closeHref: string }) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby={`agent-delete-dialog-title-${agent.id}`}
        aria-modal="true"
        className="console-dialog agent-delete-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id={`agent-delete-dialog-title-${agent.id}`}>Delete {agent.name}?</h2>
        </div>
        <p>This removes the Agent and its API key.</p>
        <div className="agent-delete-actions">
          <a className="agent-delete-cancel" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Cancel</span>
          </a>
          <form action="/api/agents" method="post">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value={agent.id} />
            <button className="agent-delete-confirm" type="submit">
              <FlatIcon name="delete" />
              <span>Delete</span>
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

function formatAgentTypeLabel(agentType: string): string {
  const labels: Record<string, string> = {
    coding: "CLI",
    desktop: "Agent",
    ide: "IDE",
    other: "Agent",
    terminal: "Terminal",
  };
  return labels[agentType] ?? agentType;
}

type AgentTypeFilter = "all" | AgentType;
type AgentStatusFilter = "all" | AgentDerivedStatus;
type AgentPlatformFilter = "all" | AgentIntegrationPlatform;

const agentTypeFilters: readonly AgentType[] = ["coding", "desktop", "terminal", "ide", "other"];
const agentStatusFilters: readonly AgentDerivedStatus[] = ["online", "offline", "high-risk"];

function readAgentTypeFilter(value: string | undefined): AgentTypeFilter {
  return agentTypeFilters.includes(value as AgentType) ? (value as AgentType) : "all";
}

function readAgentStatusFilter(value: string | undefined): AgentStatusFilter {
  return agentStatusFilters.includes(value as AgentDerivedStatus)
    ? (value as AgentDerivedStatus)
    : "all";
}

function readAgentPlatformFilter(value: string | undefined): AgentPlatformFilter {
  return agentIntegrationPlatforms.includes(value as AgentIntegrationPlatform)
    ? (value as AgentIntegrationPlatform)
    : "all";
}

function filterAgents(
  agents: ConsoleAgent[],
  filters: {
    agentPlatformFilter: AgentPlatformFilter;
    agentSearch: string;
    agentStatusFilter: AgentStatusFilter;
    agentTypeFilter: AgentTypeFilter;
  },
): ConsoleAgent[] {
  const normalizedSearch = filters.agentSearch.toLowerCase();
  return agents.filter((agent) => {
    if (filters.agentTypeFilter !== "all" && agent.agentType !== filters.agentTypeFilter) {
      return false;
    }
    if (filters.agentStatusFilter !== "all" && agent.status !== filters.agentStatusFilter) {
      return false;
    }
    if (
      filters.agentPlatformFilter !== "all" &&
      agent.integrationPlatform !== filters.agentPlatformFilter
    ) {
      return false;
    }
    if (!normalizedSearch) {
      return true;
    }
    return [
      agent.name,
      agent.keyPrefix ?? "",
      agent.agentType,
      formatAgentTypeLabel(agent.agentType),
      formatAgentIntegrationPlatformLabel(agent.integrationPlatform),
    ].some((value) => value.toLowerCase().includes(normalizedSearch));
  });
}

function formatAgentIntegrationPlatformLabel(platform: AgentIntegrationPlatform): string {
  const labels: Record<AgentIntegrationPlatform, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    "github-copilot": "GitHub Copilot",
    hermes: "Hermes",
    openclaw: "OpenClaw",
    opencode: "OpenCode",
    other: "Other",
  };
  return labels[platform];
}

function AgentStatusPill({ status }: { status: AgentDerivedStatus }) {
  if (status === "online") {
    return <span className="pill--ok pill">Online</span>;
  }
  if (status === "high-risk") {
    return <span className="pill--danger pill">High risk</span>;
  }
  return <span className="pill--warn pill">Offline</span>;
}

function formatAgentKeyPrefixDisplay(keyPrefix: string): string {
  return keyPrefix.length <= 8 ? keyPrefix : `${keyPrefix.slice(0, 6)}...${keyPrefix.slice(-4)}`;
}

function formatAgentDetailDate(value: Date): string {
  return value.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatAgentBudgetLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `$${limit.limitValue.toLocaleString()} / ${limit.period}`;
}

function formatAgentNumericLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `${formatConsoleCompactCount(limit.limitValue)} / ${limit.period}`;
}

function formatAgentTokenLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `${formatConsoleCompactCount(limit.limitValue)} / ${limit.period}`;
}

export async function LimitsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const selectedAgentId = readSingleSearchParam(searchParams.selected);
  const dialogAgentId = readSingleSearchParam(searchParams.limitDialog);
  const deleteDialogAgentId = readSingleSearchParam(searchParams.limitDelete);
  const query = readSingleSearchParam(searchParams.q)?.trim() ?? "";
  const agents = await listAgents();
  const agentLimits = await listAgentLimits();
  const runtimeSnapshots = await listAgentLimitRuntimeSnapshots();
  const agentVirtualModelAccess = await listAgentVirtualModelAccess();
  const agentLimitsByAgentId = groupByAgentId(agentLimits);
  const runtimeByAgentId = new Map(
    runtimeSnapshots.map((snapshot) => [snapshot.agentId, snapshot]),
  );
  const accessById = new Map(agentVirtualModelAccess.map((access) => [access.agentId, access]));

  const ruleAgents = agents.filter(
    (agent) => (agentLimitsByAgentId.get(agent.id) ?? []).length > 0,
  );
  const selectedAgent = selectedAgentId
    ? (agents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;
  const dialogAgent = dialogAgentId
    ? (agents.find((agent) => agent.id === dialogAgentId) ?? null)
    : null;

  const rows = ruleAgents.map((agent) => {
    const limits = agentLimitsByAgentId.get(agent.id) ?? [];
    const summaries = formatAgentLimitSummaries(limits);
    const runtime = getAgentLimitRuntimeSnapshot(agent.id, runtimeByAgentId);
    const alertThresholdPercent = readAgentAlertThresholdPercent(limits);
    const budgetUsagePercent = runtime.budgetUsagePercent;
    const status = getLimitRuleStatus({
      alertThresholdPercent,
      enabled: agent.enabled,
      usagePercent: budgetUsagePercent,
    });
    return { agent, alertThresholdPercent, budgetUsagePercent, limits, runtime, status, summaries };
  });
  const filteredRows = query
    ? rows.filter((row) => {
        const normalizedQuery = query.toLowerCase();
        return (
          row.agent.name.toLowerCase().includes(normalizedQuery) ||
          (row.agent.keyPrefix?.toLowerCase().includes(normalizedQuery) ?? false)
        );
      })
    : rows;

  const overLimitTodayCount = runtimeSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.overLimitTodayCount,
    0,
  );
  const overLimitYesterdayCount = runtimeSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.overLimitYesterdayCount,
    0,
  );
  const rateLimitHits24h = runtimeSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.rateLimitHits24h,
    0,
  );
  const nearBudgetCount = rows.filter(
    (row) => row.budgetUsagePercent >= row.alertThresholdPercent,
  ).length;
  const dialogLimits = dialogAgent ? (agentLimitsByAgentId.get(dialogAgent.id) ?? []) : [];
  const dialogRuntime = dialogAgent
    ? getAgentLimitRuntimeSnapshot(dialogAgent.id, runtimeByAgentId)
    : null;
  const dialogCloseHref = buildQueryHref(searchParams, { limitDialog: undefined });
  const deleteDialogAgent = deleteDialogAgentId
    ? (agents.find((agent) => agent.id === deleteDialogAgentId) ?? null)
    : null;
  const deleteDialogCloseHref = buildQueryHref(searchParams, { limitDelete: undefined });

  return (
    <section className="limits-dashboard" aria-label="Limits">
      <div className="limits-main">
        <div className="limits-left-column">
          <div className="stat-grid limits-kpi-grid">
            <StatCard
              icon="R"
              label="Configured rules"
              value={String(rows.length)}
              delta="Agent API Key"
            />
            <StatCard
              icon="!"
              label="Over-limit today"
              value={String(overLimitTodayCount)}
              delta={`vs yesterday ${formatSignedInteger(overLimitTodayCount - overLimitYesterdayCount)}`}
              deltaTone={formatDeltaTone(overLimitTodayCount, overLimitYesterdayCount, "down-good")}
            />
            <StatCard
              icon="B"
              label="Keys near budget"
              value={String(nearBudgetCount)}
              delta="At alert threshold"
            />
            <StatCard
              icon="L"
              label="Rate limit hits"
              value={String(rateLimitHits24h)}
              delta="Last 24h"
            />
          </div>
          <div className="limits-toolbar">
            <form className="limits-search-form" action="/limits" method="get">
              {selectedAgent ? (
                <input type="hidden" name="selected" value={selectedAgent.id} />
              ) : null}
              <label className="sr-only" htmlFor="limits-search">
                Search limit rules
              </label>
              <input
                id="limits-search"
                name="q"
                type="search"
                defaultValue={query}
                placeholder="Search Agent or API Key prefix"
              />
            </form>
          </div>
          <div className="limits-rule-card">
            <h2 className="limits-section-title">Limit Rules</h2>
            <div className="data-table-wrap limits-rule-table-wrap">
              <table className="data-table limits-rule-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>API Key</th>
                    <th className="num">Budget</th>
                    <th className="num">Tokens</th>
                    <th className="num">RPM</th>
                    <th className="num">TPM</th>
                    <th className="num">Concurrency</th>
                    <th className="num">Usage</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={10}>No limit rules configured.</td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const editHref = buildQueryHref(searchParams, {
                        limitDialog: row.agent.id,
                        selected: row.agent.id,
                      });
                      return (
                        <tr
                          key={row.agent.id}
                          className={selectedAgent?.id === row.agent.id ? "is-selected" : undefined}
                        >
                          <td>{row.agent.name}</td>
                          <td className="mono">{formatLimitsKeyPrefix(row.agent.keyPrefix)}</td>
                          <td className="num">{formatLimitBudgetCell(row.limits)}</td>
                          <td className="num">{formatLimitNumericCell(row.limits, "token")}</td>
                          <td className="num">{formatLimitNumericCell(row.limits, "rpm")}</td>
                          <td className="num">{formatLimitNumericCell(row.limits, "tpm")}</td>
                          <td className="num">
                            {formatLimitNumericCell(row.limits, "concurrency")}
                          </td>
                          <td className="num">{formatUsagePercent(row.budgetUsagePercent)}</td>
                          <td>
                            <span className={`pill limits-status-pill ${row.status.className}`}>
                              {row.status.label}
                            </span>
                          </td>
                          <td className="limits-rule-action-cell">
                            <span className="limits-rule-actions">
                              <span className="agent-table-actions">
                                <a
                                  aria-label={`Edit ${row.agent.name}`}
                                  className="link-button agent-action-edit"
                                  href={editHref}
                                >
                                  <FlatIcon name="edit" />
                                  <span>Edit</span>
                                </a>
                              </span>
                              <a
                                aria-label={`Delete ${row.agent.name}`}
                                className="limits-rule-delete-button"
                                href={buildQueryHref(searchParams, {
                                  limitDelete: row.agent.id,
                                  limitDialog: undefined,
                                })}
                              >
                                Delete
                              </a>
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {dialogAgent ? (
        <LimitsConfigDialog
          agent={dialogAgent}
          closeHref={dialogCloseHref}
          limits={dialogLimits}
          allowedVirtualModels={getLimitsVisibleVirtualModels(accessById.get(dialogAgent.id))}
          runtime={dialogRuntime ?? getEmptyAgentLimitRuntimeSnapshot(dialogAgent.id)}
        />
      ) : null}
      {deleteDialogAgent ? (
        <LimitsDeleteDialog agent={deleteDialogAgent} closeHref={deleteDialogCloseHref} />
      ) : null}
    </section>
  );
}

function LimitsConfigDialog({
  agent,
  closeHref,
  limits,
  allowedVirtualModels,
  runtime,
}: {
  agent: { id: string; keyPrefix: string | null; name: string };
  closeHref: string;
  limits: readonly ConsoleAgentLimit[];
  allowedVirtualModels: ReadonlyArray<{ id: string; displayName: string; name: string }>;
  runtime: ConsoleAgentLimitRuntimeSnapshot;
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tpmLimit = findAgentLimit(limits, "tpm");
  const concurrencyLimit = findAgentLimit(limits, "concurrency");
  const tokenLimit = findAgentLimit(limits, "token");
  const alertThresholdPercent = readAgentAlertThresholdPercent(limits);
  const usagePercent = runtime.budgetUsagePercent;
  const usageTone = usagePercent >= 95 ? "is-danger" : usagePercent >= 80 ? "is-warn" : "";

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-label="Rule configuration"
        aria-labelledby={`limits-config-title-${agent.id}`}
        aria-modal="true"
        className="console-dialog limits-config-dialog"
        role="dialog"
      >
        <div className="console-dialog-head limits-config-head">
          <div>
            <h2 className="limits-config-title" id={`limits-config-title-${agent.id}`}>
              Rule configuration
            </h2>
            <p>{agent.name}</p>
          </div>
          <span className="mono">{formatLimitsKeyPrefix(agent.keyPrefix)}</span>
          <a className="secondary-button" href={closeHref}>
            Close
          </a>
        </div>
        <form className="limits-config-form" action="/api/agent-limits" method="post">
          <input type="hidden" name="action" value="saveLimitRules" />
          <input type="hidden" name="agentId" value={agent.id} />
          <div className="limits-form-grid">
            <div className="console-field">
              <label htmlFor={`limits-budget-${agent.id}`}>Cost limit (USD)</label>
              <input
                id={`limits-budget-${agent.id}`}
                name="budgetUsd"
                type="number"
                min="0.000001"
                step="0.000001"
                defaultValue={formatInputNumber(
                  budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd,
                )}
                required
              />
            </div>
            <div className="console-field">
              <label htmlFor={`limits-token-${agent.id}`}>Token limit</label>
              <input
                id={`limits-token-${agent.id}`}
                name="tokenLimit"
                type="number"
                min="1"
                step="1"
                defaultValue={formatInputNumber(
                  tokenLimit?.limitValue ?? defaultAgentLimitFormValues.tokenLimit,
                )}
                required
              />
            </div>
            <div className="console-field">
              <label htmlFor={`limits-budget-period-${agent.id}`}>Period</label>
              <select
                id={`limits-budget-period-${agent.id}`}
                name="budgetPeriod"
                defaultValue={budgetLimit?.period ?? defaultAgentLimitFormValues.budgetPeriod}
                required
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>
            <div className="console-field">
              <label htmlFor={`limits-alert-threshold-${agent.id}`}>Alert threshold</label>
              <input
                id={`limits-alert-threshold-${agent.id}`}
                name="alertThresholdPercent"
                type="number"
                min="1"
                max="100"
                step="1"
                defaultValue={formatInputNumber(alertThresholdPercent)}
                required
              />
            </div>
          </div>
          <div className="limits-usage-block">
            <div className="usage-bar">
              <div className="usage-bar-head">
                <span>Current usage</span>
                <span>{formatUsagePercent(usagePercent)}</span>
              </div>
              <div className="usage-bar-track">
                <div
                  className={`usage-bar-fill ${usageTone}`.trim()}
                  style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }}
                />
              </div>
            </div>
          </div>
          <div>
            <h3 className="limits-config-subtitle">Rate limit caps</h3>
            <div className="limits-rate-grid">
              <div className="console-field">
                <label htmlFor={`limits-rpm-${agent.id}`}>RPM</label>
                <input
                  id={`limits-rpm-${agent.id}`}
                  name="rpm"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={formatInputNumber(
                    rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm,
                  )}
                  required
                />
              </div>
              <div className="console-field">
                <label htmlFor={`limits-tpm-${agent.id}`}>TPM</label>
                <input
                  id={`limits-tpm-${agent.id}`}
                  name="tpm"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={formatInputNumber(
                    tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm,
                  )}
                  required
                />
              </div>
              <div className="console-field">
                <label htmlFor={`limits-concurrency-${agent.id}`}>Concurrency</label>
                <input
                  id={`limits-concurrency-${agent.id}`}
                  name="concurrency"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={formatInputNumber(
                    concurrencyLimit?.limitValue ?? defaultAgentLimitFormValues.concurrency,
                  )}
                  required
                />
              </div>
            </div>
          </div>
          <div>
            <h3 className="limits-config-subtitle">Allowed Virtual Models</h3>
            <div className="tag-row">
              {allowedVirtualModels.length === 0 ? (
                <span className="tag-chip">All virtual models</span>
              ) : (
                allowedVirtualModels.map((virtualModel) => (
                  <span className="tag-chip" key={virtualModel.id}>
                    {virtualModel.name}
                  </span>
                ))
              )}
            </div>
          </div>
          <div className="limits-config-actions">
            <a className="secondary-button" href={closeHref}>
              Cancel
            </a>
            <button type="submit">
              <span>Save</span>
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

function LimitsDeleteDialog({
  agent,
  closeHref,
}: {
  agent: { id: string; name: string };
  closeHref: string;
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby={`limits-delete-dialog-title-${agent.id}`}
        aria-modal="true"
        className="console-dialog agent-delete-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id={`limits-delete-dialog-title-${agent.id}`}>
            Delete limit rules for {agent.name}?
          </h2>
        </div>
        <p>This removes every limit rule configured for this Agent API key.</p>
        <div className="agent-delete-actions">
          <a className="agent-delete-cancel" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Cancel</span>
          </a>
          <form action="/api/agent-limits" method="post">
            <input type="hidden" name="action" value="deleteLimitRules" />
            <input type="hidden" name="agentId" value={agent.id} />
            <button className="agent-delete-confirm" type="submit">
              <FlatIcon name="delete" />
              <span>Delete</span>
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

function getAgentLimitRuntimeSnapshot(
  agentId: string,
  snapshotsByAgentId: Map<string, ConsoleAgentLimitRuntimeSnapshot>,
): ConsoleAgentLimitRuntimeSnapshot {
  return snapshotsByAgentId.get(agentId) ?? getEmptyAgentLimitRuntimeSnapshot(agentId);
}

function getLimitsVisibleVirtualModels(
  access: AgentVirtualModelAccess | undefined,
): ReadonlyArray<{ id: string; displayName: string; name: string }> {
  if (!access) {
    return [];
  }
  const models: Array<{ id: string; displayName: string; name: string }> = [];
  const seen = new Set<string>();
  if (access.defaultVirtualModel) {
    models.push(access.defaultVirtualModel);
    seen.add(access.defaultVirtualModel.id);
  }
  for (const virtualModel of access.allowedVirtualModels) {
    if (!seen.has(virtualModel.id)) {
      models.push(virtualModel);
      seen.add(virtualModel.id);
    }
  }
  return models;
}

function getEmptyAgentLimitRuntimeSnapshot(agentId: string): ConsoleAgentLimitRuntimeSnapshot {
  return {
    agentId,
    budgetUsagePercent: 0,
    currentConcurrency: 0,
    currentRpm: 0,
    currentTpm: 0,
    overLimitTodayCount: 0,
    overLimitYesterdayCount: 0,
    rateLimitHits24h: 0,
  };
}

function readAgentAlertThresholdPercent(limits: readonly ConsoleAgentLimit[]): number {
  const configuredThreshold = limits.find((limit) => limit.alertThreshold !== null)?.alertThreshold;
  return (configuredThreshold ?? defaultAgentLimitFormValues.alertThresholdPercent / 100) * 100;
}

function getLimitRuleStatus({
  alertThresholdPercent,
  enabled,
  usagePercent,
}: {
  alertThresholdPercent: number;
  enabled: boolean;
  usagePercent: number;
}): { className: string; label: string } {
  if (!enabled) {
    return { className: "", label: "Disabled" };
  }
  if (usagePercent >= 100) {
    return { className: "pill--danger", label: "Blocked" };
  }
  if (usagePercent >= alertThresholdPercent) {
    return { className: "pill--warn", label: "Warning" };
  }
  return { className: "pill--ok", label: "Normal" };
}

function formatSignedInteger(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  return String(value);
}

function formatLimitsKeyPrefix(keyPrefix: string | null): string {
  if (!keyPrefix) {
    return "No key";
  }
  if (keyPrefix.length <= 8) {
    return keyPrefix;
  }
  return `${keyPrefix.slice(0, 5)}...${keyPrefix.slice(-3)}`;
}

function formatLimitBudgetCell(limits: readonly ConsoleAgentLimit[]): string {
  const limit = findAgentLimit(limits, "budget");
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `$${limit.limitValue.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatLimitNumericCell(
  limits: readonly ConsoleAgentLimit[],
  limitType: ConsoleAgentLimit["limitType"],
): string {
  const limit = findAgentLimit(limits, limitType);
  if (!limit?.enabled) {
    return "Not configured";
  }
  return formatInteger(limit.limitValue);
}

function formatUsagePercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatInputNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export async function ModelsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const providerModelOptions = await listProviderModelOptions();
  const providers = new Set(providerModelOptions.map((option) => option.providerKey));
  const pricedCount = providerModelOptions.filter(
    (option) => option.priceStatus !== "unknown_price",
  ).length;
  const selectedModelId = readSingleSearchParam(searchParams.model);
  const selectedModel =
    providerModelOptions.find((option) => option.id === selectedModelId) ??
    providerModelOptions[0] ??
    null;

  return (
    <section className="providers-panel" aria-label="Model directory">
      <div className="stat-grid">
        <StatCard icon="MO" label="Models" value={String(providerModelOptions.length)} />
        <StatCard icon="PR" label="Providers" value={String(providers.size)} />
        <StatCard icon="$" label="Priced models" value={String(pricedCount)} />
      </div>
      {providerModelOptions.length === 0 ? (
        <div className="chart-card">
          <h2 className="chart-card-title">Model directory</h2>
          <p>No provider models discovered yet. Refresh models on the Providers page.</p>
        </div>
      ) : (
        <div className="detail-layout">
          <div className="chart-card">
            <h2 className="chart-card-title">Model directory</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>Model ID</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th>Price source</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {providerModelOptions.map((option) => (
                    <tr
                      key={option.id}
                      className={selectedModel?.id === option.id ? "is-selected" : "is-clickable"}
                    >
                      <td>{option.providerDisplayName}</td>
                      <td>
                        <a href={buildQueryHref(searchParams, { model: option.id })}>
                          {option.modelDisplayName}
                        </a>
                      </td>
                      <td className="mono">{option.modelId}</td>
                      <td className="num">
                        {formatModelPriceCell(option.inputUsdPerMillionTokens)}
                      </td>
                      <td className="num">
                        {formatModelPriceCell(option.outputUsdPerMillionTokens)}
                      </td>
                      <td>{option.priceStatusLabel}</td>
                      <td>
                        {option.providerEnabled ? (
                          <span className="pill--ok pill">Enabled</span>
                        ) : (
                          <span className="pill">Disabled</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {selectedModel ? <ModelPricePanel model={selectedModel} /> : null}
        </div>
      )}
    </section>
  );
}

function formatModelPriceCell(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function ModelPricePanel({ model }: { model: ConsoleProviderModelOption }) {
  const input = model.inputUsdPerMillionTokens;
  const output = model.outputUsdPerMillionTokens;
  const isPriced = input !== null && output !== null;
  const inputLabel = input === null ? "Unknown input price" : `$${input.toFixed(2)} / 1M input`;
  const outputLabel =
    output === null ? "Unknown output price" : `$${output.toFixed(2)} / 1M output`;
  const estimateLabel = isPriced ? `$${(input + output).toFixed(2)}` : "Unavailable";

  return (
    <div className="detail-panel price-panel">
      <div className="detail-panel-head">
        <div>
          <p className="detail-section-label">Prices</p>
          <h2 className="detail-panel-title">{model.modelId}</h2>
        </div>
        <span className="price-source">{model.priceStatusLabel}</span>
      </div>
      <dl className="detail-field-list">
        <div className="detail-field">
          <dt>Input</dt>
          <dd>{inputLabel}</dd>
        </div>
        <div className="detail-field">
          <dt>Output</dt>
          <dd>{outputLabel}</dd>
        </div>
        <div className="detail-field">
          <dt>1M input + 1M output</dt>
          <dd>{estimateLabel}</dd>
        </div>
      </dl>
      <form className="price-form" action="/api/prices/override" method="post">
        <input type="hidden" name="providerKey" value={model.providerKey} />
        <input type="hidden" name="modelId" value={model.modelId} />
        <input type="hidden" name="redirectModel" value={model.id} />
        <label htmlFor="override-input-price">Override input price</label>
        <input
          id="override-input-price"
          name="inputUsdPerMillionTokens"
          type="number"
          min="0"
          step="0.00000001"
          defaultValue={input ?? ""}
          required
        />
        <label htmlFor="override-output-price">Override output price</label>
        <input
          id="override-output-price"
          name="outputUsdPerMillionTokens"
          type="number"
          min="0"
          step="0.00000001"
          defaultValue={output ?? ""}
          required
        />
        <button type="submit">
          <span>Save</span>
        </button>
      </form>
    </div>
  );
}

export async function ProvidersSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const providers = orderProvidersForConsole(await listProviders());
  const providerHealthSummaries = await listConsoleProviderHealthSummaries();
  const providerKeys = await listProviderApiKeyMetadata();
  const providerOAuthConnections = await listConsoleProviderOAuthConnections();
  const providerModelOptions = orderProviderModelsForConsole(await listProviderModelOptions());
  const providerKeysByProviderId = groupProviderKeysByProviderId(providerKeys);
  const providerDialog = readSingleSearchParam(searchParams.providerDialog);
  const providerDelete = readSingleSearchParam(searchParams.providerDelete);
  const providerError = readSingleSearchParam(searchParams.providerError);
  const providerErrorField = readSingleSearchParam(searchParams.providerErrorField);
  const providerDialogCloseHref = buildQueryHref(searchParams, {
    providerBaseUrlValue: undefined,
    providerDialog: undefined,
    providerDisplayNameValue: undefined,
    providerError: undefined,
    providerErrorField: undefined,
    providerKeyValue: undefined,
  });
  const providerDeleteCloseHref = buildQueryHref(searchParams, {
    providerDelete: undefined,
  });
  const providerFormValues = {
    baseUrl: readSingleSearchParam(searchParams.providerBaseUrlValue) ?? "",
    displayName: readSingleSearchParam(searchParams.providerDisplayNameValue) ?? "",
    providerKey: readSingleSearchParam(searchParams.providerKeyValue) ?? "",
  };
  const providerKeyDialog = readSingleSearchParam(searchParams.providerKeyDialog);
  const providerKeyDelete = readSingleSearchParam(searchParams.providerKeyDelete);
  const providerOAuthError = readSingleSearchParam(searchParams.providerOAuthError);
  const providerOAuthId = readSingleSearchParam(searchParams.providerOAuthId);
  const providerOAuthLabelValue = readSingleSearchParam(searchParams.providerOAuthLabelValue);
  const providerOAuthPriorityValue = readSingleSearchParam(searchParams.providerOAuthPriorityValue);
  const providerAuthorizeUrl = readSingleSearchParam(searchParams.providerAuthorizeUrl);
  const providerKeyDialogCloseHref = buildQueryHref(searchParams, {
    providerKeyDelete: undefined,
    providerKeyDialog: undefined,
    providerAuthorizeUrl: undefined,
    providerOAuthError: undefined,
    providerOAuthId: undefined,
    providerOAuthLabelValue: undefined,
    providerOAuthPriorityValue: undefined,
  });
  const editDialogProvider =
    providerDialog && providerDialog !== "new"
      ? (providers.find((provider) => provider.id === providerDialog) ?? null)
      : null;
  const deleteDialogProvider = providers.find((provider) => provider.id === providerDelete) ?? null;
  const selectedProviderId = readSingleSearchParam(searchParams.selected);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers.find((provider) => provider.providerKey === "openai") ??
    providers[0] ??
    null;
  const selectedProviderKeys = selectedProvider
    ? (providerKeysByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const deleteProviderKey = selectedProviderKeys.find(
    (providerKey) => providerKey.id === providerKeyDelete,
  );

  return (
    <section className="providers-dashboard" aria-label="Providers & Models">
      <ProvidersClientSection
        initialSelectedProviderId={selectedProviderId ?? undefined}
        providerHealthSummaries={providerHealthSummaries}
        providerKeys={providerKeys}
        providerModelOptions={providerModelOptions}
        providerOAuthConnections={providerOAuthConnections}
        providers={providers}
        searchParams={searchParams}
      />
      {providerDialog === "new" ? (
        <ProviderCreateDialog
          closeHref={providerDialogCloseHref}
          error={providerError}
          errorField={providerErrorField}
          formValues={providerFormValues}
        />
      ) : null}
      {providerKeyDialog && selectedProvider ? (
        selectedProvider.providerType === "subscription" ? (
          <ProviderOAuthCreateDialog
            authorizeUrl={providerAuthorizeUrl}
            closeHref={providerKeyDialogCloseHref}
            error={providerOAuthError}
            labelValue={providerOAuthLabelValue}
            provider={selectedProvider}
            providerOAuthId={providerOAuthId}
            priorityValue={providerOAuthPriorityValue}
          />
        ) : (
          <ProviderKeyCreateDialog
            closeHref={providerKeyDialogCloseHref}
            provider={selectedProvider}
          />
        )
      ) : null}
      {deleteProviderKey && selectedProvider ? (
        <ProviderKeyDeleteDialog
          closeHref={providerKeyDialogCloseHref}
          keyPrefix={deleteProviderKey.keyPrefix}
          providerApiKeyId={deleteProviderKey.id}
          provider={selectedProvider}
        />
      ) : null}
      {deleteDialogProvider ? (
        <ProviderDeleteDialog closeHref={providerDeleteCloseHref} provider={deleteDialogProvider} />
      ) : null}
      {editDialogProvider ? (
        <ProviderEditDialog
          closeHref={providerDialogCloseHref}
          error={providerError}
          errorField={providerErrorField}
          formValues={{
            baseUrl: providerFormValues.baseUrl || editDialogProvider.baseUrl || "",
            displayName: providerFormValues.displayName || editDialogProvider.displayName,
          }}
          provider={editDialogProvider}
        />
      ) : null}
    </section>
  );
}

function ProviderCreateDialog({
  closeHref,
  error,
  errorField,
  formValues,
}: {
  closeHref: string;
  error?: string;
  errorField?: string;
  formValues: { baseUrl: string; displayName: string; providerKey: string };
}) {
  const formError = error && errorField === "form" ? error : undefined;
  const providerKeyError = errorField === "providerKey" ? error : undefined;
  const displayNameError = errorField === "displayName" ? error : undefined;
  const baseUrlError = errorField === "baseUrl" ? error : undefined;
  const selectedChoice =
    providerCreateChoices.find((choice) => choice.providerKey === formValues.providerKey) ??
    defaultProviderCreateChoice;

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="new-provider-dialog-title"
        aria-modal="true"
        className="console-dialog provider-create-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id="new-provider-dialog-title">Add Provider</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <ProviderCreateForm
          baseUrlError={baseUrlError}
          choices={providerCreateChoices}
          displayNameError={displayNameError}
          formError={formError}
          initialBaseUrl={formValues.baseUrl}
          initialDisplayName={formValues.displayName}
          initialProviderKey={selectedChoice.providerKey}
          providerKeyError={providerKeyError}
        />
      </section>
    </>
  );
}

function ProviderEditDialog({
  closeHref,
  error,
  errorField,
  formValues,
  provider,
}: {
  closeHref: string;
  error?: string;
  errorField?: string;
  formValues: { baseUrl: string; displayName: string };
  provider: ConsoleProvider;
}) {
  const formError = error && errorField === "form" ? error : undefined;
  const displayNameError = errorField === "displayName" ? error : undefined;
  const baseUrlError = errorField === "baseUrl" ? error : undefined;

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="edit-provider-dialog-title"
        aria-modal="true"
        className="console-dialog provider-edit-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id="edit-provider-dialog-title">Edit {provider.displayName}</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <form className="provider-create-form" action="/api/providers" method="post">
          <input type="hidden" name="action" value="update" />
          <input type="hidden" name="id" value={provider.id} />
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <label htmlFor="provider-edit-display-name">Provider display name</label>
          <input
            aria-describedby="provider-edit-display-name-error"
            aria-invalid={displayNameError ? true : undefined}
            className={displayNameError ? "is-invalid" : undefined}
            defaultValue={formValues.displayName}
            id="provider-edit-display-name"
            name="displayName"
            required
          />
          <p
            className={displayNameError ? "field-error is-visible" : "field-error"}
            id="provider-edit-display-name-error"
          >
            {displayNameError}
          </p>
          <label htmlFor="provider-edit-base-url">Provider base URL</label>
          <input
            aria-describedby="provider-edit-base-url-error"
            aria-invalid={baseUrlError ? true : undefined}
            className={baseUrlError ? "is-invalid" : undefined}
            defaultValue={formValues.baseUrl}
            id="provider-edit-base-url"
            name="baseUrl"
            readOnly={Boolean(provider.providerTemplateId)}
            type="url"
          />
          <p
            className={baseUrlError ? "field-error is-visible" : "field-error"}
            id="provider-edit-base-url-error"
          >
            {baseUrlError}
          </p>
          <button type="submit">
            <span>Save</span>
          </button>
        </form>
      </section>
    </>
  );
}

function ProviderKeyCreateDialog({
  closeHref,
  provider,
}: {
  closeHref: string;
  provider: ConsoleProvider;
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="provider-key-create-title"
        aria-modal="true"
        className="console-dialog provider-key-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id="provider-key-create-title">New {provider.displayName} API key</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <form className="provider-create-form" action="/api/provider-keys" method="post">
          <input type="hidden" name="providerId" value={provider.id} />
          <label htmlFor="provider-key-create-value">Provider API key</label>
          <input
            autoComplete="off"
            id="provider-key-create-value"
            name="providerApiKey"
            required
            type="password"
          />
          <label htmlFor="provider-key-create-label">Label</label>
          <input id="provider-key-create-label" maxLength={100} name="label" type="text" />
          <label htmlFor="provider-key-create-priority">Priority</label>
          <input
            defaultValue={100}
            id="provider-key-create-priority"
            max={100}
            min={0}
            name="priority"
            step={1}
            type="number"
          />
          <button type="submit">
            <span>Save</span>
          </button>
        </form>
      </section>
    </>
  );
}

function ProviderOAuthCreateDialog({
  authorizeUrl,
  closeHref,
  error,
  labelValue,
  provider,
  providerOAuthId,
  priorityValue,
}: {
  authorizeUrl?: string;
  closeHref: string;
  error?: string;
  labelValue?: string;
  provider: ConsoleProvider;
  providerOAuthId?: string;
  priorityValue?: string;
}) {
  const hasPendingAuthorization = Boolean(authorizeUrl && providerOAuthId);
  const priorityDefaultValue = priorityValue ?? "100";

  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="provider-oauth-create-title"
        aria-modal="true"
        className="console-dialog provider-key-dialog"
        role="dialog"
      >
        <div className="console-dialog-head">
          <h2 id="provider-oauth-create-title">New {provider.displayName} OAuth connection</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {hasPendingAuthorization ? (
          <>
            <div className="provider-create-form">
              <label htmlFor="provider-oauth-authorize-url">Authorization URL</label>
              <textarea
                id="provider-oauth-authorize-url"
                readOnly
                rows={4}
                defaultValue={authorizeUrl}
              />
              <a
                className="oauth-open-link secondary-button"
                href={authorizeUrl}
                target="_blank"
                rel="noreferrer"
              >
                <FlatIcon name="view" />
                <span>Open authorization URL</span>
              </a>
            </div>
            <form className="provider-create-form" action="/api/provider-oauth" method="post">
              <input type="hidden" name="action" value="complete" />
              <input type="hidden" name="providerId" value={provider.id} />
              <input type="hidden" name="providerOAuthId" value={providerOAuthId} />
              <input type="hidden" name="providerAuthorizeUrl" value={authorizeUrl} />
              <label htmlFor="provider-oauth-complete-label">Label</label>
              <input
                id="provider-oauth-complete-label"
                maxLength={100}
                name="label"
                type="text"
                defaultValue={labelValue ?? ""}
              />
              <label htmlFor="provider-oauth-complete-priority">Priority</label>
              <input
                defaultValue={priorityDefaultValue}
                id="provider-oauth-complete-priority"
                max={100}
                min={0}
                name="priority"
                step={1}
                type="number"
              />
              <label htmlFor="provider-oauth-callback-input">
                Callback URL or authorization code
              </label>
              <textarea id="provider-oauth-callback-input" name="callbackInput" required rows={4} />
              <button className="oauth-action-button" type="submit">
                <FlatIcon name="confirm" />
                <span>Connect OAuth</span>
              </button>
            </form>
          </>
        ) : null}
      </section>
    </>
  );
}

function ProviderDeleteDialog({
  closeHref,
  provider,
}: {
  closeHref: string;
  provider: ConsoleProvider;
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="provider-delete-title"
        aria-modal="true"
        className="console-dialog agent-delete-dialog"
        role="dialog"
      >
        <h2 id="provider-delete-title">Delete provider?</h2>
        <p>This removes {provider.displayName} from the provider list.</p>
        <div className="agent-delete-actions">
          <a className="agent-delete-cancel" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Cancel</span>
          </a>
          <form action="/api/providers" method="post">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value={provider.id} />
            <button className="agent-delete-confirm" type="submit">
              <FlatIcon name="delete" />
              <span>Delete provider</span>
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

function ProviderKeyDeleteDialog({
  closeHref,
  keyPrefix,
  providerApiKeyId,
  provider,
}: {
  closeHref: string;
  keyPrefix: string;
  providerApiKeyId: string;
  provider: ConsoleProvider;
}) {
  return (
    <>
      <div className="console-dialog-scrim" aria-hidden="true" />
      <section
        aria-labelledby="provider-key-delete-title"
        aria-modal="true"
        className="console-dialog agent-delete-dialog"
        role="dialog"
      >
        <h2 id="provider-key-delete-title">Delete API key?</h2>
        <p>
          This removes key {keyPrefix} from {provider.displayName}.
        </p>
        <div className="agent-delete-actions">
          <a className="agent-delete-cancel" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Cancel</span>
          </a>
          <form action="/api/provider-keys" method="post">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="providerApiKeyId" value={providerApiKeyId} />
            <button className="agent-delete-confirm" type="submit">
              <FlatIcon name="delete" />
              <span>Delete key</span>
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

export async function SettingsSection() {
  const securitySummary = await getConsoleSecuritySummary();
  const notificationChannels = await listNotificationChannels();
  return (
    <section className="providers-panel" id="settings" aria-label="Settings">
      <div className="settings-layout">
        <div className="settings-sections">
          <section
            className="settings-panel"
            id="settings-general"
            aria-labelledby="settings-general-title"
          >
            <h3 id="settings-general-title">General</h3>
            <div className="settings-grid">
              <div className="console-field">
                <label htmlFor="settings-language">Default language</label>
                <select id="settings-language" defaultValue="en" disabled>
                  <option value="en">English</option>
                  <option value="zh">Chinese</option>
                </select>
              </div>
              <div className="console-field">
                <label htmlFor="settings-range">Default time range</label>
                <select id="settings-range" defaultValue="7d" disabled>
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
              </div>
              <div className="console-field">
                <label htmlFor="settings-currency">Default currency</label>
                <select id="settings-currency" defaultValue="usd" disabled>
                  <option value="usd">USD</option>
                </select>
              </div>
            </div>
            <p className="callout">Console preferences are display-only in this build.</p>
          </section>

          <section
            className="settings-panel"
            id="settings-security"
            aria-labelledby="settings-security-title"
          >
            <h3 id="settings-security-title">Security</h3>
            <dl className="detail-field-list">
              <div className="detail-field">
                <dt>Admin password</dt>
                <dd>{securitySummary.adminPasswordSet ? "Set" : "Not set"}</dd>
              </div>
              <div className="detail-field">
                <dt>Active sessions</dt>
                <dd>{securitySummary.activeSessionCount}</dd>
              </div>
            </dl>
            <p className="callout">
              Password change and session management are managed via deployment configuration.
            </p>
          </section>

          <section
            className="settings-panel"
            id="notification-channels"
            aria-labelledby="notification-channels-title"
          >
            <h3 id="notification-channels-title">Notification channels</h3>
            <div className="provider-list">
              {notificationChannels.length === 0 ? (
                <p>No notification channels configured.</p>
              ) : (
                notificationChannels.map((channel) => (
                  <article className="provider-item" key={channel.id}>
                    <header className="provider-header">
                      <div>
                        <p className="eyebrow">{channel.channelType}</p>
                        <h3>{channel.displayName}</h3>
                      </div>
                      <p className={channel.enabled ? "status-enabled" : "status-disabled"}>
                        {channel.enabled ? "Enabled" : "Disabled"}
                      </p>
                    </header>
                    <p>{formatNotificationChannelConfig(channel)}</p>
                  </article>
                ))
              )}
            </div>
            <div className="settings-grid">
              <form
                className="provider-create-form"
                action="/api/notification-channels"
                method="post"
              >
                <input type="hidden" name="action" value="create" />
                <input type="hidden" name="channelType" value="webhook" />
                <label htmlFor="notification-webhook-name">Webhook channel name</label>
                <input
                  id="notification-webhook-name"
                  name="displayName"
                  placeholder="Ops alerts"
                  required
                />
                <label htmlFor="notification-webhook-url">Webhook URL</label>
                <input
                  id="notification-webhook-url"
                  name="webhookUrl"
                  type="url"
                  placeholder="https://hooks.example.com/llmingress"
                  required
                />
                <button className="notification-channel-save-button" type="submit">
                  <span>Save</span>
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function formatNotificationChannelConfig(channel: ConsoleNotificationChannel): string {
  const config = channel.config as { url?: string };
  return `Webhook: ${formatWebhookUrlForDisplay(config.url)}`;
}

function formatWebhookUrlForDisplay(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "Unknown webhook URL";
  }

  try {
    const url = new URL(rawUrl);
    if (url.search) {
      url.search = "?redacted";
    }
    url.password = "";
    url.username = "";
    return url.toString();
  } catch {
    return "Invalid webhook URL";
  }
}

function getPlaygroundGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

function formatDateTime(value: Date): string {
  return value.toISOString();
}

function formatConfigVersion(value: number | null): string {
  return value === null ? "None" : `v${value}`;
}

function readSingleSearchParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function formatActivityProviderLabel(activity: ConsoleActivity): string {
  return activity.providerDisplayName ?? activity.providerKey ?? "Unknown provider";
}

function formatActivityModelSummary(activity: ConsoleActivity): string {
  return activity.providerModelName ?? activity.model ?? "Unknown model";
}

function formatActivityProviderModelLabel(activity: ConsoleActivity): string {
  return `${formatActivityProviderLabel(activity)} / ${formatActivityModelDisplayLabel(activity)}`;
}

function formatActivityModelDisplayLabel(activity: ConsoleActivity): string {
  const displayName =
    activity.providerModelDisplayName ?? activity.providerModelName ?? activity.model ?? null;
  if (!displayName) {
    return "Unknown model";
  }
  if (activity.providerModelName && displayName !== activity.providerModelName) {
    return `${displayName} (${activity.providerModelName})`;
  }
  return displayName;
}

function activityFallbackCount(activity: ConsoleActivity): number {
  if (Array.isArray(activity.fallbackAttempts)) {
    return activity.fallbackAttempts.length;
  }
  return 0;
}

type ActivityRange = "24h" | "7d" | "30d";

function parseActivityRange(value: string | undefined): ActivityRange {
  if (value === "24h" || value === "30d") {
    return value;
  }
  return "7d";
}

function getActivityWindowStart(now: Date, range: ActivityRange): Date {
  const days = range === "24h" ? 1 : range === "30d" ? 30 : 7;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function formatRouteReasonStrategy(routeReason: unknown): string {
  if (isActivityRecord(routeReason) && typeof routeReason.strategy === "string") {
    return routeReason.strategy;
  }
  return "Unknown";
}

function formatFallbackEventModel(event: ConsoleFallbackEvent): string {
  return (
    event.providerModelDisplayName ??
    event.providerModelName ??
    event.providerModelId ??
    "Unknown provider model"
  );
}

function formatFallbackEventResult(event: ConsoleFallbackEvent): string {
  if (event.status === "succeeded") {
    return "Success";
  }
  return event.errorMessage ?? event.errorCode ?? event.status;
}

function buildActivityMetadataLines(activity: ConsoleActivity, metadata: unknown): string[] {
  const safeLines = formatConsoleActivityMetadata(metadata).filter(
    (line) => line !== "No request metadata recorded",
  );
  return [
    `protocol: ${activity.protocol}`,
    `http_status: ${activity.httpStatus ?? "—"}`,
    `model: ${activity.model ?? "—"}`,
    `started_at: ${formatDateTime(activity.startedAt)}`,
    ...safeLines,
  ];
}

function formatActivityError(activity: ConsoleActivity): string {
  if (activity.errorCode) {
    return activity.errorMessage
      ? `Error: ${activity.errorCode} - ${activity.errorMessage}`
      : `Error: ${activity.errorCode}`;
  }
  return activity.errorMessage ?? "Error details unavailable";
}

function activityTimelineStepClass(status: string): string {
  if (status === "succeeded") {
    return "activity-timeline-step activity-timeline-step-ok";
  }
  return "activity-timeline-step activity-timeline-step-danger";
}

function isActivityRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRoutePolicyCandidateList(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate) => candidate.optionLabel).join(", ");
}

function formatDefaultCandidate(routePolicy: ConsoleRoutePolicy | null | undefined): string {
  return routePolicy?.candidates[0]?.modelDisplayName ?? MISSING_VALUE;
}

function parseUsd(value: number | string | null): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatVirtualModelCost(value: number | string | null): string {
  return formatConsoleUsd(parseUsd(value));
}

function formatVirtualModelFailureRate(
  requestCount: number,
  failureCount: number,
  digits = 1,
): string {
  if (requestCount <= 0) {
    return `${(0).toFixed(digits)}%`;
  }
  return `${((failureCount / requestCount) * 100).toFixed(digits)}%`;
}

function formatRouteStrategyLabel(strategy: string): string {
  if (strategy === "cost_first") {
    return "Cost First";
  }
  if (strategy === "quality_first") {
    return "Quality First";
  }
  if (strategy === "random") {
    return "Random";
  }
  return strategy.charAt(0).toUpperCase() + strategy.slice(1);
}

function formatRoutePolicyCandidateOrder(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate, index) => `${index + 1}. ${candidate.optionLabel}`).join(" -> ");
}

function providerModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
}

function virtualModelSelectSize(optionCount: number): number {
  return Math.min(8, Math.max(2, optionCount));
}

function listRoutePolicyProviderFilterOptions(
  providerModels: Awaited<ReturnType<typeof listProviderModelOptions>>,
) {
  const providersByKey = new Map<string, { providerDisplayName: string; providerKey: string }>();
  for (const providerModel of providerModels) {
    if (!providersByKey.has(providerModel.providerKey)) {
      providersByKey.set(providerModel.providerKey, {
        providerDisplayName: providerModel.providerDisplayName,
        providerKey: providerModel.providerKey,
      });
    }
  }
  return Array.from(providersByKey.values()).sort((left, right) =>
    left.providerDisplayName.localeCompare(right.providerDisplayName),
  );
}

function buildRoutePolicyHealthWarningCandidates(
  routePolicy: Awaited<ReturnType<typeof listRoutePolicies>>[number],
  providerHealthByProviderId: Map<string, ConsoleProviderHealthSummary>,
) {
  return routePolicy.candidates.map((candidate) => {
    const providerHealth = providerHealthByProviderId.get(candidate.providerId);
    const modelHealth = providerHealth?.models.find((model) => model.id === candidate.id);
    return {
      modelHealthIsStale: modelHealth?.isStale ?? false,
      modelHealthStatus: modelHealth?.status ?? null,
      optionLabel: candidate.optionLabel,
      providerHealthIsStale: providerHealth?.isStale ?? false,
      providerHealthStatus: providerHealth?.status ?? null,
    };
  });
}

function groupProviderKeysByProviderId(providerKeys: ProviderApiKeyMetadata[]) {
  const grouped = new Map<string, ProviderApiKeyMetadata[]>();

  for (const providerKey of providerKeys) {
    const keys = grouped.get(providerKey.providerId) ?? [];
    keys.push(providerKey);
    grouped.set(providerKey.providerId, keys);
  }

  return grouped;
}

function orderProvidersForConsole(providers: ConsoleProvider[]): ConsoleProvider[] {
  return [...providers].sort((left, right) => {
    const leftOrder = getConsoleProviderOrder(left.providerKey);
    const rightOrder = getConsoleProviderOrder(right.providerKey);
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

function orderProviderModelsForConsole(
  providerModels: ConsoleProviderModelOption[],
): ConsoleProviderModelOption[] {
  return [...providerModels].sort((left, right) => {
    const leftOrder = getConsoleProviderOrder(left.providerKey);
    const rightOrder = getConsoleProviderOrder(right.providerKey);
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.modelDisplayName.localeCompare(right.modelDisplayName);
  });
}

function getConsoleProviderOrder(providerKey: string): number {
  const preferredOrder = new Map([
    ["openai", 0],
    ["anthropic", 1],
    ["google", 2],
    ["openrouter", 3],
    ["ollama", 4],
  ]);
  return preferredOrder.get(providerKey) ?? 100;
}

function formatModelPrice(price: number | null): string {
  if (price === null) {
    return "Unknown";
  }
  const digits = price >= 1 ? 2 : 4;
  return `$${price.toFixed(digits)}`;
}

function formatVirtualModelOptionLabel(virtualModel: {
  description?: string;
  displayName?: string;
  name: string;
}): string {
  return virtualModel.name;
}

function findAgentLimit(
  limits: readonly ConsoleAgentLimit[],
  limitType: ConsoleAgentLimit["limitType"],
): ConsoleAgentLimit | undefined {
  return limits.find((limit) => limit.limitType === limitType);
}

function groupByAgentId<T extends { agentId: string }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = grouped.get(value.agentId) ?? [];
    group.push(value);
    grouped.set(value.agentId, group);
  }
  return grouped;
}
