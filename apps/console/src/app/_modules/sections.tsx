import {
  type ConsoleActivity,
  formatConsoleActivityCost,
  formatConsoleActivityFallbackAttempts,
  formatConsoleActivityRouteReason,
  listConsoleActivities,
} from "../../server/activity";
import {
  buildAgentIntegrationTemplates,
  formatDashboardAgentApiKeySnippetValue,
  resolveAgentIntegrationModelName,
} from "../../server/agent-integrations";
import {
  type ConsoleAgentLimit,
  defaultAgentLimitFormValues,
  formatAgentLimitSummaries,
  listAgentLimits,
} from "../../server/agent-limits";
import {
  type AgentVirtualModelAccess,
  agentIntegrationPlatforms,
  type ConsoleAgent,
  listAgents,
  listAgentVirtualModelAccess,
} from "../../server/agents";
import { getConsoleDatabaseUrl } from "../../server/auth";
import { placeholderFloat, placeholderInt, placeholderTrend } from "../../server/mock-data";
import {
  type ConsoleNotificationChannel,
  listNotificationChannels,
} from "../../server/notification-channels";
import {
  type ConsoleProviderHealthSummary,
  formatProviderHealthLatestProbe,
  formatProviderHealthStatus,
  listConsoleProviderHealthSummaries,
} from "../../server/provider-health";
import {
  listProviderApiKeyMetadata,
  type ProviderApiKeyMetadata,
} from "../../server/provider-keys";
import { listProviderTemplateSelectorGroups } from "../../server/provider-templates";
import { type ConsoleProvider, listProviders } from "../../server/providers";
import {
  buildRoutePolicyHealthWarnings,
  type ConsoleProviderModelOption,
  type ConsoleRoutePolicy,
  filterRoutePolicyEditorProviderModelOptions,
  listProviderModelOptions,
  listRoutePolicies,
  mergeRoutePolicyEditorProviderModelOptions,
  normalizeRoutePolicyEditorFilters,
  routePolicyStrategies,
} from "../../server/route-policies";
import {
  type ConsoleGatewayRuntimeStatus,
  formatGatewayHeartbeatStatus,
  formatRuntimeReloadResult,
  getConsoleRuntimeSnapshot,
} from "../../server/runtime";
import {
  type ConsoleUsageDimensionBreakdown,
  formatConsoleUsageCost,
  getConsoleUsageSummary,
  parseConsoleUsageWindow,
} from "../../server/usage";
import { type ConsoleVirtualModel, listVirtualModels } from "../../server/virtual-models";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { chartAccent, chartOk } from "../_components/charts/palette";
import { TrendLineChart } from "../_components/charts/trend-line-chart";
import { FlatIcon } from "../_components/flat-icon";
import { Disclosure, Pager, Row } from "../_components/list-ui";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref, paginate, readPageParam } from "../_lib/pagination";
import { ProviderCreateForm } from "./provider-create-form";
import { VirtualModelRouteDialogClient } from "./virtual-model-route-dialog";

export type ConsoleSearchParams = Record<string, string | string[] | undefined>;

const providerTemplateGroups = listProviderTemplateSelectorGroups();
const directProviderCreateChoices = [
  {
    action: "create",
    baseUrlMode: "fixed_create",
    displayName: "OpenAI",
    fixedBaseUrl: "https://api.openai.com/v1",
    id: "openai",
    providerKey: "openai",
    providerType: "api_key",
  },
  {
    action: "create",
    baseUrlMode: "fixed_create",
    displayName: "Anthropic",
    fixedBaseUrl: "https://api.anthropic.com/v1",
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
      id: template.id,
      providerKey: template.providerKey,
      providerType: template.providerType,
    })),
  ),
];

export async function OverviewSection() {
  const databaseUrl = getConsoleDatabaseUrl();
  const usageSummary = await getConsoleUsageSummary({ databaseUrl, window: "24h" });
  const activities = await listConsoleActivities(databaseUrl);
  const agents = await listAgents(databaseUrl);
  const runtimeSnapshot = await getConsoleRuntimeSnapshot(databaseUrl);
  const providerHealthSummaries = await listConsoleProviderHealthSummaries({ databaseUrl });
  const gateway = runtimeSnapshot.gateways[0] ?? null;

  const recentActivities = activities.slice(0, 8);
  const activeAgentCount =
    usageSummary.agentBreakdowns.filter((agent) => agent.requestCount > 0).length ||
    agents.filter((agent) => agent.enabled).length;
  const failureRate =
    usageSummary.requestCount > 0
      ? `${((usageSummary.failureCount / usageSummary.requestCount) * 100).toFixed(2)}%`
      : "0.00%";
  const trend = placeholderTrend("overview-trend", 14);
  const topAgents = buildTopAgentsByCost(usageSummary.agentBreakdowns, recentActivities);

  return (
    <section className="overview-dashboard" aria-label="Overview">
      <div className="stat-grid overview-stat-grid">
        <StatCard
          icon="RQ"
          label="Requests today"
          value={formatCompactNumber(usageSummary.requestCount)}
          delta={formatOverviewDelta("overview-requests", "up")}
          deltaTone="up"
        />
        <StatCard
          icon="$"
          label="Cost today"
          value={formatOverviewMoney(usageSummary.totalCostUsd)}
          delta={formatOverviewDelta("overview-cost", "up")}
          deltaTone="up"
        />
        <StatCard
          icon="TK"
          label="Tokens today"
          value={formatCompactNumber(usageSummary.totalTokens)}
          delta={formatOverviewDelta("overview-tokens", "up")}
          deltaTone="up"
        />
        <StatCard icon="FR" label="Failure rate" value={failureRate} delta="vs yesterday -0.4%" />
        <StatCard
          icon="SV"
          label="Savings"
          value={formatOverviewMoney(usageSummary.totalSavingsUsd)}
          delta={formatOverviewDelta("overview-savings", "up")}
          deltaTone="up"
        />
        <StatCard
          icon="AG"
          label="Active agents"
          value={String(activeAgentCount)}
          delta="vs yesterday +1"
          deltaTone="up"
        />
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
                      <td className="mono">{formatTime(activity.startedAt)}</td>
                      <td>{activity.agentName ?? "Unknown agent"}</td>
                      <td>{formatActivityVirtualModelLabel(activity)}</td>
                      <td>{formatActivityModelSummary(activity)}</td>
                      <td>{formatActivityProviderLabel(activity)}</td>
                      <td className="num">{formatCompactNumber(activity.totalTokens ?? 0)}</td>
                      <td className="num">{formatOverviewActivityCost(activity.totalCostUsd)}</td>
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
        <div className="detail-panel">
          <div className="detail-panel-head">
            <h2 className="detail-panel-title">Gateway status</h2>
            <span className={gateway ? "pill--ok pill" : "pill--warn pill"}>
              {gateway ? gateway.status : "Unknown"}
            </span>
          </div>
          <div className={gateway ? "overview-status-banner" : "overview-status-banner is-warn"}>
            <span aria-hidden="true">✓</span>
            <div>
              <strong>{formatGatewayOverviewStatus(gateway)}</strong>
              <small>{gateway ? "All systems normal" : "No gateway heartbeat recorded"}</small>
            </div>
          </div>
          <dl className="detail-field-list">
            <div className="detail-field">
              <dt>Runtime address</dt>
              <dd>{formatRuntimeAddress(getPlaygroundGatewayBaseUrl())}</dd>
            </div>
            <div className="detail-field">
              <dt>Version</dt>
              <dd>v0.1.0</dd>
            </div>
            <div className="detail-field">
              <dt>Uptime</dt>
              <dd>{gateway ? formatUptime(gateway.startedAt) : "Unknown"}</dd>
            </div>
            <div className="detail-field">
              <dt>Provider status</dt>
              <dd>{formatProviderStatusSummary(providerHealthSummaries)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="chart-grid-2">
        <div className="chart-card">
          <h2 className="chart-card-title">Requests &amp; cost trend</h2>
          <TrendLineChart
            ariaLabel="Requests and cost trend"
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

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

function formatOverviewMoney(totalCostUsd: string | null): string {
  const value = totalCostUsd === null ? 0 : Number(totalCostUsd);
  if (!Number.isFinite(value)) {
    return "$0.00";
  }
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function formatOverviewActivityCost(totalCostUsd: string | null): string {
  return totalCostUsd === null ? "Unavailable" : formatOverviewMoney(totalCostUsd);
}

function formatOverviewDelta(seed: string, direction: "up" | "down"): string {
  const sign = direction === "up" ? "+" : "-";
  return `vs yesterday ${sign}${placeholderFloat(seed, 4, 22, 1)}%`;
}

function formatTime(value: Date): string {
  return value.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatActivityLatency(latencyMs: number | null): string {
  if (latencyMs === null) {
    return "—";
  }
  return `${(latencyMs / 1000).toFixed(2)}s`;
}

function formatGatewayOverviewStatus(gateway: ConsoleGatewayRuntimeStatus | null): string {
  if (!gateway) {
    return "Status unknown";
  }
  return gateway.status === "ready" &&
    formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt }) === "Healthy"
    ? "Running normally"
    : `Gateway ${gateway.status}`;
}

function formatRuntimeAddress(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatUptime(startedAt: Date): string {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatProviderStatusSummary(summaries: ConsoleProviderHealthSummary[]): string {
  const healthy = summaries.filter((summary) => summary.status === "healthy").length;
  const unhealthy = summaries.filter(
    (summary) => summary.status === "degraded" || summary.status === "unhealthy",
  ).length;
  return `${healthy} healthy / ${unhealthy} unhealthy`;
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

const runtimeObservabilityExports = [
  { id: "prometheus", name: "Prometheus Metrics", detail: "/metrics" },
  { id: "otel", name: "OpenTelemetry Traces", detail: "Enabled" },
  { id: "webhook", name: "Webhook Events", detail: "Notification channels" },
  { id: "jsonl", name: "JSONL Request Logs", detail: "Local file" },
];

const runtimeSecurityNotes = [
  "Provider API keys are encrypted with AES-256-GCM and decrypted only in memory.",
  "Agent API keys are stored as a hash; the full key is shown once at creation.",
  "Gateway runtime config is applied from the deployed config version; the Console cannot restart processes.",
  "This page is read-only runtime status — it does not change any stored settings.",
];

export async function RuntimeSection() {
  const databaseUrl = getConsoleDatabaseUrl();
  const runtimeSnapshot = await getConsoleRuntimeSnapshot(databaseUrl);
  const providerHealthSummaries = await listConsoleProviderHealthSummaries({ databaseUrl });
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
        <StatCard icon="URL" label="Runtime address" value={getPlaygroundGatewayBaseUrl()} />
        <StatCard icon="V" label="Version" value="v0.1.0" />
        <StatCard
          icon="HB"
          label="Heartbeat"
          value={gateway ? formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt }) : "—"}
        />
      </div>

      <div className="chart-grid-2">
        <div className="chart-card">
          <h3 className="chart-card-title">Provider connectivity</h3>
          {providerHealthSummaries.length === 0 ? (
            <p>No providers configured.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Status</th>
                    <th className="num">p95</th>
                    <th>Last checked</th>
                  </tr>
                </thead>
                <tbody>
                  {providerHealthSummaries.map((summary) => (
                    <tr key={summary.id}>
                      <td>{summary.displayName}</td>
                      <td>
                        <ProviderHealthPill status={summary.status} />
                      </td>
                      <td className="num">{placeholderInt(summary.id, 18, 580, 3)}ms</td>
                      <td>
                        {formatProviderHealthLatestProbe({
                          latestProbeAt: summary.latestProbeAt,
                          trigger: summary.trigger,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="chart-card">
          <h3 className="chart-card-title">Recent runtime errors</h3>
          {runtimeSnapshot.errors.length === 0 ? (
            <p>No runtime errors recorded.</p>
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
      </div>

      <div className="chart-card">
        <h3 className="chart-card-title">Observability exports</h3>
        <div className="stat-grid">
          {runtimeObservabilityExports.map((entry) => (
            <article className="stat-card" key={entry.id}>
              <div className="stat-card-head">
                <span className="stat-card-icon" aria-hidden="true">
                  {entry.id.slice(0, 2).toUpperCase()}
                </span>
                <span className="stat-card-label">{entry.name}</span>
              </div>
              <span className="stat-card-delta">{entry.detail}</span>
            </article>
          ))}
        </div>
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
              {runtimeSnapshot.migrations.migrateCheckHealth.status === "ready"
                ? "Ready"
                : "Blocked"}
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

function ProviderHealthPill({ status }: { status: string }) {
  return (
    <ProviderStatusPill
      label={formatProviderHealthStatus(status as Parameters<typeof formatProviderHealthStatus>[0])}
      status={status}
    />
  );
}

function ProviderHealthPillZh({ status }: { status: string }) {
  return <ProviderStatusPill label={formatProviderHealthStatusZhLabel(status)} status={status} />;
}

function ModelAvailabilityPill({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  if (normalized === "available") {
    return <span className="pill--ok pill">启用</span>;
  }
  if (normalized === "disabled") {
    return <span className="pill--danger pill">禁用</span>;
  }
  return <span className="pill">{formatModelAvailability(value)}</span>;
}

function ProviderStatusPill({ label, status }: { label: string; status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "healthy") {
    return <span className="pill--ok pill">{label}</span>;
  }
  if (normalized === "unknown") {
    return <span className="pill">{label}</span>;
  }
  if (normalized === "degraded") {
    return <span className="pill--warn pill">{label}</span>;
  }
  return <span className="pill--danger pill">{label}</span>;
}

function formatProviderHealthStatusZhLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "healthy") {
    return "健康";
  }
  if (normalized === "disabled") {
    return "禁用";
  }
  if (normalized === "degraded" || normalized === "unhealthy") {
    return "异常";
  }
  return "未知";
}

export async function UsageSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const usageWindow = parseConsoleUsageWindow(readSingleSearchParam(searchParams.usageWindow));
  const usageSummary = await getConsoleUsageSummary({ databaseUrl, window: usageWindow });

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
  // Average latency is not part of the usage rollup yet; seeded placeholder.
  const avgLatency = `${placeholderFloat(`usage-latency-${usageSummary.window}`, 0.8, 2.6).toFixed(2)}s`;
  const trend = placeholderTrend(`usage-trend-${usageSummary.window}`, 14);

  return (
    <section className="providers-panel" id="usage" aria-label="Usage & Cost">
      <form className="filter-bar" action="/usage" method="get">
        <div className="console-field">
          <label htmlFor="usage-window">Window</label>
          <select id="usage-window" name="usageWindow" defaultValue={usageSummary.window}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
        <div className="console-actions">
          <button type="submit">
            <FlatIcon name="filter" />
            <span>Apply</span>
          </button>
        </div>
      </form>

      <div className="stat-grid">
        <StatCard
          icon="$"
          label="Total cost"
          value={formatConsoleUsageCost(usageSummary.totalCostUsd)}
        />
        <StatCard
          icon="TK"
          label="Total tokens"
          value={formatCompactNumber(usageSummary.totalTokens)}
        />
        <StatCard
          icon="RQ"
          label="Total requests"
          value={formatCompactNumber(usageSummary.requestCount)}
        />
        <StatCard icon="LT" label="Avg latency" value={avgLatency} />
        <StatCard icon="FR" label="Failure rate" value={failureRate} />
        <StatCard
          icon="SV"
          label="Savings"
          value={formatConsoleUsageCost(usageSummary.totalSavingsUsd)}
        />
      </div>

      <div className="chart-grid-2">
        <div className="chart-card">
          <h2 className="chart-card-title">Cost trend</h2>
          <TrendLineChart
            ariaLabel="Cost trend"
            data={trend}
            series={[{ key: "costUsd", name: "Cost (USD)", color: chartOk }]}
          />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Tokens trend</h2>
          <TrendLineChart
            ariaLabel="Tokens trend"
            data={trend}
            series={[{ key: "requests", name: "Requests", color: chartAccent }]}
          />
        </div>
      </div>

      <div className="chart-grid-3">
        <div className="chart-card">
          <h2 className="chart-card-title">Agent cost</h2>
          <UsageCostDonut breakdowns={usageSummary.agentBreakdowns} label="agent" />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Virtual Model cost</h2>
          <UsageCostDonut breakdowns={usageSummary.virtualModelBreakdowns} label="virtual model" />
        </div>
        <div className="chart-card">
          <h2 className="chart-card-title">Provider cost</h2>
          <UsageCostDonut breakdowns={usageSummary.providerBreakdowns} label="provider" />
        </div>
      </div>

      <div className="detail-layout">
        <div className="chart-card">
          <h2 className="chart-card-title">Provider / Model summary</h2>
          {usageSummary.breakdowns.length === 0 ? (
            <p>No usage recorded for this window.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th className="num">Requests</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usageSummary.breakdowns.map((breakdown) => (
                    <tr key={`${breakdown.providerId}:${breakdown.modelId}`}>
                      <td>{breakdown.providerLabel}</td>
                      <td>{breakdown.modelLabel}</td>
                      <td className="num">{formatCompactNumber(breakdown.requestCount)}</td>
                      <td className="num">{formatCompactNumber(breakdown.totalTokens)}</td>
                      <td className="num">{formatConsoleUsageCost(breakdown.totalCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="detail-panel">
          <div className="detail-panel-head">
            <h2 className="detail-panel-title">Savings</h2>
          </div>
          <dl className="detail-field-list">
            <div className="detail-field">
              <dt>Saved amount</dt>
              <dd>{formatConsoleUsageCost(usageSummary.totalSavingsUsd)}</dd>
            </div>
            <div className="detail-field">
              <dt>Savings ratio</dt>
              <dd>{savingsRatio}</dd>
            </div>
            <div className="detail-field">
              <dt>Billed cost</dt>
              <dd>{formatConsoleUsageCost(usageSummary.totalCostUsd)}</dd>
            </div>
          </dl>
          <p className="callout">
            Savings estimate the difference vs. each request's most expensive candidate.
          </p>
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
    .map((breakdown) => ({ name: breakdown.label, value: Number(breakdown.totalCostUsd ?? 0) }))
    .filter((slice) => slice.value > 0)
    .slice(0, 6);
  if (slices.length === 0) {
    return <p>No {label} cost recorded.</p>;
  }
  return <DonutBreakdown ariaLabel={`${label} cost breakdown`} data={slices} valueFormat="usd" />;
}

export async function ActivitySection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const selectedActivityId = readSingleSearchParam(searchParams.activityId);
  const statusFilter = readSingleSearchParam(searchParams.status) ?? "";
  const requestQuery = (readSingleSearchParam(searchParams.q) ?? "").trim();
  const allActivities = await listConsoleActivities(databaseUrl);
  const statusOptions = Array.from(
    new Set(allActivities.map((activity) => activity.status)),
  ).sort();

  // Filtering runs over the fetched rows (the activity query is unparameterized).
  const activities = allActivities.filter((activity) => {
    if (statusFilter && activity.status !== statusFilter) {
      return false;
    }
    if (requestQuery && !activity.requestId.toLowerCase().includes(requestQuery.toLowerCase())) {
      return false;
    }
    return true;
  });

  const selectedActivity =
    activities.find((activity) => activity.id === selectedActivityId) ?? activities[0] ?? null;
  const view = paginate(activities, readPageParam(searchParams));

  return (
    <section className="providers-panel" id="activity" aria-label="Activity">
      <form className="filter-bar" action="/activity" method="get">
        <div className="console-field">
          <label htmlFor="activity-status">Status</label>
          <select id="activity-status" name="status" defaultValue={statusFilter}>
            <option value="">All statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
        <div className="console-field">
          <label htmlFor="activity-q">Request ID</label>
          <input id="activity-q" name="q" defaultValue={requestQuery} placeholder="req_..." />
        </div>
        <div className="console-actions">
          <button type="submit">
            <FlatIcon name="filter" />
            <span>Apply</span>
          </button>
        </div>
      </form>

      {allActivities.length === 0 ? (
        <p>No activity recorded.</p>
      ) : (
        <div className="detail-layout">
          <div className="activity-list-col">
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Provider / Model</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                    <th className="num">Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.length === 0 ? (
                    <tr>
                      <td colSpan={6}>No requests match the filters.</td>
                    </tr>
                  ) : (
                    view.items.map((activity) => (
                      <tr
                        key={activity.id}
                        className={
                          selectedActivity?.id === activity.id ? "is-selected" : "is-clickable"
                        }
                      >
                        <td className="mono">
                          <a href={buildQueryHref(searchParams, { activityId: activity.id })}>
                            {activity.requestId}
                          </a>
                        </td>
                        <td>{formatActivityModelSummary(activity)}</td>
                        <td className="num">{formatCompactNumber(activity.totalTokens ?? 0)}</td>
                        <td className="num">{formatConsoleActivityCost(activity.totalCostUsd)}</td>
                        <td className="num">{formatActivityLatency(activity.latencyMs)}</td>
                        <td>
                          <ActivityStatusPill status={activity.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <Pager view={view} searchParams={searchParams} />
          </div>
          {selectedActivity ? (
            <section className="detail-panel" aria-labelledby="activity-detail-title">
              <div className="detail-panel-head">
                <h2 className="detail-panel-title" id="activity-detail-title">
                  Request detail
                </h2>
                <ActivityStatusPill status={selectedActivity.status} />
              </div>
              <p className="key-display">{selectedActivity.requestId}</p>
              <dl className="detail-field-list">
                <div className="detail-field">
                  <dt>Provider</dt>
                  <dd>{formatActivityProviderLabel(selectedActivity)}</dd>
                </div>
                <div className="detail-field">
                  <dt>Model hit</dt>
                  <dd>{formatActivityModelHitLabel(selectedActivity)}</dd>
                </div>
                <div className="detail-field">
                  <dt>Tokens</dt>
                  <dd>{formatCompactNumber(selectedActivity.totalTokens ?? 0)}</dd>
                </div>
                <div className="detail-field">
                  <dt>Cost</dt>
                  <dd>{formatConsoleActivityCost(selectedActivity.totalCostUsd)}</dd>
                </div>
                <div className="detail-field">
                  <dt>Latency</dt>
                  <dd>{formatActivityLatency(selectedActivity.latencyMs)}</dd>
                </div>
                <div className="detail-field">
                  <dt>Route reason</dt>
                  <dd>{formatConsoleActivityRouteReason(selectedActivity.routeReason)}</dd>
                </div>
              </dl>
              <div>
                <p className="detail-section-label">Fallback timeline</p>
                <ul className="timeline">
                  {formatConsoleActivityFallbackAttempts(selectedActivity.fallbackAttempts).map(
                    (attempt) => (
                      <li key={attempt}>{attempt}</li>
                    ),
                  )}
                </ul>
              </div>
              {selectedActivity.errorCode ? (
                <p className="callout callout--warn">Error: {selectedActivity.errorCode}</p>
              ) : null}
              <div>
                <p className="detail-section-label">Request metadata</p>
                <pre className="code-block">
                  {`protocol: ${selectedActivity.protocol}
http_status: ${selectedActivity.httpStatus ?? "—"}
model: ${selectedActivity.model ?? "—"}
started_at: ${formatDateTime(selectedActivity.startedAt)}`}
                </pre>
                <p className="callout">Prompt / response bodies are not stored.</p>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}

export async function VirtualModelsSection({
  searchParams,
}: {
  searchParams: ConsoleSearchParams;
}) {
  const databaseUrl = getConsoleDatabaseUrl();
  const virtualModels = await listVirtualModels(databaseUrl);
  const routePolicies = await listRoutePolicies(databaseUrl);
  const providerModelOptions = orderProviderModelsForConsole(
    await listProviderModelOptions(databaseUrl),
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
  const selectedVirtualModelId = readSingleSearchParam(searchParams.selected);
  const selectedVirtualModel =
    visibleVirtualModels.find((virtualModel) => virtualModel.id === selectedVirtualModelId) ??
    visibleVirtualModels[0] ??
    null;
  const selectedRoutePolicy = selectedVirtualModel
    ? (routePolicyByVmId.get(selectedVirtualModel.id) ?? null)
    : null;
  const dialogTarget = readSingleSearchParam(searchParams.virtualModelDialog);
  const dialogVirtualModel =
    dialogTarget && dialogTarget !== "new"
      ? (virtualModels.find((virtualModel) => virtualModel.id === dialogTarget) ?? null)
      : null;
  const dialogRoutePolicy = dialogVirtualModel
    ? (routePolicyByVmId.get(dialogVirtualModel.id) ?? null)
    : null;
  const dialogCloseHref = buildQueryHref(searchParams, { virtualModelDialog: undefined });
  const fallbackOverview = [
    { name: "未触发回退", value: 82 },
    { name: "gpt-4o-mini", value: 12 },
    { name: "其他", value: 6 },
  ];
  return (
    <section className="vm-dashboard" aria-label="Virtual models and routes">
      <div className="stat-grid">
        <StatCard icon="VM" label="Virtual Models" value={String(virtualModels.length)} />
        <StatCard
          icon="Q"
          label="今日请求"
          value={formatCompactNumber(placeholderInt("vm-requests", 4000, 20000))}
          delta="较昨日 +12.5%"
        />
        <StatCard
          icon="$"
          label="本月成本"
          value={formatVirtualModelCost(placeholderFloat("vm-cost", 80, 260, 2))}
          delta="较上月 -8.3%"
        />
        <StatCard
          icon="!"
          label="平均失败率"
          value={`${placeholderFloat("vm-failure", 0.8, 2.2, 2).toFixed(2)}%`}
          delta="较昨日 -0.4pp"
        />
      </div>
      <form className="vm-filter-bar" action="/models" method="get">
        <div>
          <label htmlFor="vm-status-filter">状态</label>
          <select id="vm-status-filter" name="vmStatus" defaultValue={statusFilter}>
            <option value="">全部</option>
            <option value="enabled">启用</option>
            <option value="disabled">禁用</option>
          </select>
        </div>
        <div>
          <label htmlFor="vm-strategy-filter">Strategy</label>
          <select id="vm-strategy-filter" name="vmStrategy" defaultValue={strategyFilter}>
            <option value="">全部</option>
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
          placeholder="搜索 Virtual Model Name"
          defaultValue={readSingleSearchParam(searchParams.vmQuery) ?? ""}
        />
        <button type="submit">
          <FlatIcon name="filter" />
          <span>筛选</span>
        </button>
      </form>
      <div className="vm-shell">
        <div className="agents-main-column">
          <div className="chart-card">
            <h2 className="chart-card-title">Virtual Model 列表</h2>
            {visibleVirtualModels.length === 0 ? (
              <p>No virtual models configured.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table vm-table">
                  <thead>
                    <tr>
                      <th>Virtual Model</th>
                      <th>Strategy</th>
                      <th className="num">候选数</th>
                      <th>默认命中模型</th>
                      <th className="num">今日请求</th>
                      <th className="num">今日成本</th>
                      <th className="num">失败率</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVirtualModels.map((virtualModel) => {
                      const policy = routePolicyByVmId.get(virtualModel.id);
                      const selected = virtualModel.id === selectedVirtualModel?.id;
                      return (
                        <tr
                          className={selected ? "is-selected" : "is-clickable"}
                          key={virtualModel.id}
                        >
                          <td>
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                selected: virtualModel.id,
                                virtualModelDialog: undefined,
                              })}
                            >
                              {virtualModel.name}
                            </a>
                          </td>
                          <td>
                            {policy ? (
                              <span className="pill--info pill">
                                {formatRouteStrategyLabel(policy.strategy)}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="num">{policy?.candidates.length ?? 0}</td>
                          <td>{formatDefaultCandidate(policy)}</td>
                          <td className="num">
                            {formatCompactNumber(
                              placeholderInt(`${virtualModel.id}-requests`, 900, 9800),
                            )}
                          </td>
                          <td className="num">
                            {formatVirtualModelCost(
                              placeholderFloat(`${virtualModel.id}-cost`, 5, 90, 2),
                            )}
                          </td>
                          <td className="num">
                            {placeholderFloat(`${virtualModel.id}-fail`, 0.5, 2.6, 1).toFixed(1)}%
                          </td>
                          <td>
                            {virtualModel.enabled ? (
                              <span className="pill--ok pill">启用</span>
                            ) : (
                              <span className="pill">禁用</span>
                            )}
                          </td>
                          <td>
                            <a
                              className="table-action-link"
                              href={buildQueryHref(searchParams, {
                                virtualModelDialog: virtualModel.id,
                              })}
                            >
                              <FlatIcon name="edit" />
                              <span>编辑</span>
                            </a>
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
        <aside className="agent-detail-card vm-detail-card">
          {selectedVirtualModel ? (
            <>
              <div className="agent-detail-head">
                <h2>{selectedVirtualModel.name}</h2>
                {selectedVirtualModel.enabled ? (
                  <span className="pill--ok pill">启用</span>
                ) : (
                  <span className="pill">禁用</span>
                )}
              </div>
              <dl className="agent-detail-fields">
                <div>
                  <dt>Strategy</dt>
                  <dd>
                    {selectedRoutePolicy
                      ? formatRouteStrategyLabel(selectedRoutePolicy.strategy)
                      : "-"}
                  </dd>
                </div>
                <div>
                  <dt>Candidates</dt>
                  <dd>
                    {selectedRoutePolicy ? `${selectedRoutePolicy.candidates.length} 个模型` : "-"}
                  </dd>
                </div>
                <div>
                  <dt>默认命中</dt>
                  <dd>{formatDefaultCandidate(selectedRoutePolicy)}</dd>
                </div>
                <div>
                  <dt>今日请求</dt>
                  <dd>
                    {formatCompactNumber(
                      placeholderInt(`${selectedVirtualModel.id}-detail-requests`, 900, 9800),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>今日成本</dt>
                  <dd>
                    {formatVirtualModelCost(
                      placeholderFloat(`${selectedVirtualModel.id}-detail-cost`, 5, 90, 2),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>失败率</dt>
                  <dd>
                    {placeholderFloat(
                      `${selectedVirtualModel.id}-detail-fail`,
                      0.5,
                      2.6,
                      1,
                    ).toFixed(1)}
                    %
                  </dd>
                </div>
              </dl>
              <section className="agent-detail-section">
                <h3>Candidates</h3>
                {selectedRoutePolicy?.candidates.length ? (
                  <div className="vm-candidate-list">
                    {selectedRoutePolicy.candidates.map((candidate) => (
                      <div
                        className="vm-candidate-card"
                        key={`${candidate.id}-${candidate.isFallback}`}
                      >
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
                          <span className="pill--ok pill">健康</span>
                        ) : (
                          <span className="pill--danger pill">禁用</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>No candidates configured.</p>
                )}
              </section>
              <section className="agent-detail-section">
                <h3>Fallback 概览</h3>
                <DonutBreakdown
                  ariaLabel="Fallback overview"
                  data={fallbackOverview}
                  valueFormat="percent"
                />
              </section>
            </>
          ) : (
            <p>No Virtual Model selected.</p>
          )}
        </aside>
      </div>
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
          providerModelOptions={mergeRoutePolicyEditorProviderModelOptions(
            providerModelOptions,
            dialogRoutePolicy?.candidates ?? [],
          )}
          routePolicy={dialogRoutePolicy}
          virtualModel={dialogVirtualModel}
        />
      ) : null}
    </section>
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
  const databaseUrl = getConsoleDatabaseUrl();
  const routePolicyEditorFilters = normalizeRoutePolicyEditorFilters({
    modelQuery: readSingleSearchParam(searchParams.routeModelFilter),
    providerKey: readSingleSearchParam(searchParams.routeProviderFilter),
  });
  const virtualModels = await listVirtualModels(databaseUrl);
  const routePolicies = await listRoutePolicies(databaseUrl);
  const providerModelOptions = await listProviderModelOptions(databaseUrl);
  const providerHealthSummaries = await listConsoleProviderHealthSummaries({ databaseUrl });
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
            <select id="route-policy-strategy" name="strategy" required defaultValue="balanced">
              {routePolicyStrategies.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {strategy}
                </option>
              ))}
            </select>
            <label htmlFor="route-policy-primary-models">Primary provider models</label>
            <select
              id="route-policy-primary-models"
              name="primaryProviderModelIds"
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
            <label htmlFor="route-policy-fallback-models">Fallback provider models</label>
            <select
              id="route-policy-fallback-models"
              name="fallbackProviderModelIds"
              multiple
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
                <p>Primary: {formatRoutePolicyCandidateList(routePolicy.primaryCandidates)}</p>
                <p>Fallback: {formatRoutePolicyCandidateList(routePolicy.fallbackCandidates)}</p>
                <p>
                  Fallback order: {formatRoutePolicyFallbackOrder(routePolicy.fallbackCandidates)}
                </p>
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
                  <label htmlFor={`route-policy-primary-models-${routePolicy.id}`}>
                    Edit primary provider models
                  </label>
                  <select
                    id={`route-policy-primary-models-${routePolicy.id}`}
                    name="primaryProviderModelIds"
                    defaultValue={routePolicy.primaryCandidates.map((candidate) => candidate.id)}
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
                  <label htmlFor={`route-policy-fallback-models-${routePolicy.id}`}>
                    Edit fallback provider models
                  </label>
                  <select
                    id={`route-policy-fallback-models-${routePolicy.id}`}
                    name="fallbackProviderModelIds"
                    defaultValue={routePolicy.fallbackCandidates.map((candidate) => candidate.id)}
                    multiple
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
  const databaseUrl = getConsoleDatabaseUrl();
  const playgroundGatewayBaseUrl = getPlaygroundGatewayBaseUrl();
  const usageToday = await getConsoleUsageSummary({ databaseUrl, window: "24h" });
  const usageWeek = await getConsoleUsageSummary({ databaseUrl, window: "7d" });
  const agents = await listAgents(databaseUrl);
  const agentVirtualModelAccess = await listAgentVirtualModelAccess(databaseUrl);
  const agentLimits = await listAgentLimits(databaseUrl);
  const virtualModels = await listVirtualModels(databaseUrl);
  const agentVirtualModelAccessByAgentId = new Map(
    agentVirtualModelAccess.map((access) => [access.agentId, access]),
  );
  const agentLimitsByAgentId = groupByAgentId(agentLimits);
  const connectedAgentCount = agents.filter((agent) => agent.hasApiKey).length;
  const usageTodayByAgentId = new Map(usageToday.agentBreakdowns.map((agent) => [agent.id, agent]));
  const selectedAgentId = readSingleSearchParam(searchParams.selected);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;
  const selectedAccess = selectedAgent
    ? (agentVirtualModelAccessByAgentId.get(selectedAgent.id) ?? null)
    : null;
  const selectedLimits = selectedAgent ? (agentLimitsByAgentId.get(selectedAgent.id) ?? []) : [];
  const selectedBudgetLimit = findAgentLimit(selectedLimits, "budget");
  const selectedTokenLimit = findAgentLimit(selectedLimits, "token");
  const selectedRpmLimit = findAgentLimit(selectedLimits, "rpm");
  const selectedTpmLimit = findAgentLimit(selectedLimits, "tpm");
  const selectedIntegrationAccess = selectedAgent
    ? (selectedAccess ?? {
        agentId: selectedAgent.id,
        allowedVirtualModels: [],
        defaultVirtualModel: null,
      })
    : null;
  const selectedIntegrationTemplates =
    selectedAgent?.keyPrefix && selectedIntegrationAccess
      ? buildAgentIntegrationTemplates({
          apiKey: formatDashboardAgentApiKeySnippetValue(selectedAgent.keyPrefix),
          gatewayBaseUrl: playgroundGatewayBaseUrl,
          model: resolveAgentIntegrationModelName(selectedIntegrationAccess),
        })
      : [];
  const agentDialog = readSingleSearchParam(searchParams.agentDialog);
  const editDialogAgent = agents.find((agent) => agent.id === agentDialog) ?? null;
  const agentDialogCloseHref = buildQueryHref(searchParams, { agentDialog: undefined });
  const deleteAgent = readSingleSearchParam(searchParams.deleteAgent);
  const deleteDialogAgent = agents.find((agent) => agent.id === deleteAgent) ?? null;
  const deleteDialogCloseHref = buildQueryHref(searchParams, { deleteAgent: undefined });

  return (
    <section className="agents-dashboard" aria-label="Agents">
      <div className="agents-shell">
        <div className="agents-main-column">
          <div className="stat-grid agents-stat-grid">
            <StatCard icon="AG" label="Agents" value={String(agents.length)} />
            <StatCard icon="ON" label="Connected" value={String(connectedAgentCount)} />
            <StatCard
              icon="RQ"
              label="Requests today"
              value={formatCompactNumber(usageToday.requestCount)}
              delta={formatOverviewDelta("agents-requests", "up")}
              deltaTone="up"
            />
            <StatCard
              icon="$"
              label="Cost this week"
              value={formatOverviewMoney(usageWeek.totalCostUsd)}
              delta={formatOverviewDelta("agents-cost", "up")}
              deltaTone="up"
            />
          </div>
          <fieldset className="agents-filter-bar">
            <legend className="sr-only">Agent filters</legend>
            <div className="console-field">
              <label htmlFor="agent-filter-type">Type</label>
              <select id="agent-filter-type" defaultValue="all">
                <option value="all">All</option>
                <option value="coding">Coding</option>
                <option value="terminal">Terminal</option>
                <option value="ide">IDE</option>
                <option value="desktop">Desktop</option>
              </select>
            </div>
            <div className="console-field">
              <label htmlFor="agent-filter-status">Status</label>
              <select id="agent-filter-status" defaultValue="all">
                <option value="all">All</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>
            </div>
            <div className="console-field">
              <label htmlFor="agent-filter-platform">Platform</label>
              <select id="agent-filter-platform" defaultValue="all">
                <option value="all">All</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="cursor">Cursor</option>
              </select>
            </div>
            <div className="console-field agents-search-field">
              <label htmlFor="agent-filter-search" className="sr-only">
                Search
              </label>
              <input
                id="agent-filter-search"
                name="agentSearch"
                placeholder="Search agent name or note"
              />
            </div>
          </fieldset>
          <div className="chart-card agents-list-card">
            <h2 className="chart-card-title">Agent list</h2>
            {agents.length === 0 ? (
              <p>No agents yet — create one below.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table agents-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Type</th>
                      <th>API Key Prefix</th>
                      <th>Default Virtual Model</th>
                      <th className="num">Available VM</th>
                      <th className="num">Requests today</th>
                      <th className="num">Today Cost</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent) => {
                      const access = agentVirtualModelAccessByAgentId.get(agent.id);
                      const usage = usageTodayByAgentId.get(agent.id);
                      return (
                        <tr
                          className={
                            agent.id === selectedAgent?.id ? "is-selected" : "is-clickable"
                          }
                          key={agent.id}
                        >
                          <td>
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {agent.name}
                            </a>
                          </td>
                          <td>
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {formatAgentTypeLabel(agent.agentType)}
                            </a>
                          </td>
                          <td className="mono">
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {agent.keyPrefix
                                ? formatAgentKeyPrefixDisplay(agent.keyPrefix)
                                : "No key"}
                            </a>
                          </td>
                          <td>
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {access?.defaultVirtualModel?.name ?? "None"}
                            </a>
                          </td>
                          <td className="num">
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {access?.allowedVirtualModels.length ?? 0}
                            </a>
                          </td>
                          <td className="num">
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {formatCompactNumber(usage?.requestCount ?? 0)}
                            </a>
                          </td>
                          <td className="num">
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {formatOverviewMoney(usage?.totalCostUsd ?? null)}
                            </a>
                          </td>
                          <td>
                            <a
                              className="table-row-link"
                              href={buildQueryHref(searchParams, {
                                agentDialog: undefined,
                                selected: agent.id,
                              })}
                            >
                              {agent.hasApiKey ? (
                                <span className="pill--ok pill">Online</span>
                              ) : (
                                <span className="pill--warn pill">Offline</span>
                              )}
                            </a>
                          </td>
                          <td>
                            <span className="agent-table-actions">
                              <a
                                className="link-button agent-action-edit"
                                href={buildQueryHref(searchParams, { agentDialog: agent.id })}
                              >
                                <FlatIcon name="edit" />
                                <span>Edit</span>
                              </a>
                              <a
                                className="link-button agent-action-delete"
                                href={buildQueryHref(searchParams, {
                                  agentDialog: undefined,
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
        <aside className="agent-detail-card" aria-label="Selected agent details">
          {selectedAgent?.keyPrefix ? (
            <>
              <div className="agent-detail-head">
                <h2>{selectedAgent.name}</h2>
                <span className="pill--ok pill">Online</span>
              </div>
              <dl className="agent-detail-fields">
                <div>
                  <dt>Type</dt>
                  <dd>{formatAgentTypeLabel(selectedAgent.agentType)}</dd>
                </div>
                <div>
                  <dt>Platform</dt>
                  <dd>{formatAgentPlatform(selectedAgent.name, selectedAgent.agentType)}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatAgentDetailDate(selectedAgent.createdAt)}</dd>
                </div>
                <div>
                  <dt>Default model</dt>
                  <dd>{selectedAccess?.defaultVirtualModel?.name ?? "None"}</dd>
                </div>
              </dl>
              <section className="agent-detail-section">
                <h3>Allowed Virtual Models</h3>
                <div className="agent-chip-list">
                  {(selectedAccess?.allowedVirtualModels ?? []).map((virtualModel) => (
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
                  <strong>{formatAgentBudgetLimit(selectedBudgetLimit)}</strong>
                </div>
                <div className="agent-limit-row">
                  <span>RPM</span>
                  <strong>{formatAgentNumericLimit(selectedRpmLimit)}</strong>
                </div>
                <div className="agent-limit-row">
                  <span>TPM</span>
                  <strong>{formatAgentNumericLimit(selectedTpmLimit)}</strong>
                </div>
                <div className="agent-limit-row">
                  <span>Token limit</span>
                  <strong>{formatAgentTokenLimit(selectedTokenLimit)}</strong>
                </div>
              </section>
              <section className="agent-detail-section">
                <h3>Integration snippets</h3>
                {selectedIntegrationTemplates.length > 0 ? (
                  <fieldset className="agent-integration-snippets">
                    <legend>Agent integration snippets</legend>
                    {selectedIntegrationTemplates.map((template) => (
                      <div className="agent-integration-snippet" key={template.id}>
                        <label htmlFor={`${template.id}-setup-snippet-${selectedAgent.id}`}>
                          {template.displayName} setup snippet
                        </label>
                        <textarea
                          id={`${template.id}-setup-snippet-${selectedAgent.id}`}
                          readOnly
                          rows={4}
                          defaultValue={template.snippet}
                        />
                      </div>
                    ))}
                  </fieldset>
                ) : (
                  <p>No integration snippets available.</p>
                )}
              </section>
            </>
          ) : (
            <p>No agent selected.</p>
          )}
        </aside>
      </div>
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
          <label htmlFor="agent-budget-usd">Budget USD limit</label>
          <input
            id="agent-budget-usd"
            name="budgetUsd"
            type="number"
            min="0.000001"
            step="0.000001"
            defaultValue={defaultAgentLimitFormValues.budgetUsd}
            required
          />
          <label htmlFor="agent-budget-period">Budget period</label>
          <select
            id="agent-budget-period"
            name="budgetPeriod"
            defaultValue={defaultAgentLimitFormValues.budgetPeriod}
            required
          >
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
          <label htmlFor="agent-rpm">RPM limit</label>
          <input
            id="agent-rpm"
            name="rpm"
            type="number"
            min="1"
            step="1"
            defaultValue={defaultAgentLimitFormValues.rpm}
            required
          />
          <label htmlFor="agent-tpm">TPM limit</label>
          <input
            id="agent-tpm"
            name="tpm"
            type="number"
            min="1"
            step="1"
            defaultValue={defaultAgentLimitFormValues.tpm}
            required
          />
          <label htmlFor="agent-token-limit">Token limit</label>
          <input
            id="agent-token-limit"
            name="tokenLimit"
            type="number"
            min="1"
            step="1"
            defaultValue={defaultAgentLimitFormValues.tokenLimit}
            required
          />
          <button type="submit">
            <FlatIcon name="add" />
            <span>Create agent</span>
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
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tokenLimit = findAgentLimit(limits, "token");
  const tpmLimit = findAgentLimit(limits, "tpm");

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
            id={`agent-allowed-virtual-models-${agent.id}`}
            name="allowedVirtualModelIds"
            defaultValue={access.allowedVirtualModels.map((virtualModel) => virtualModel.id)}
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
          <button type="submit">
            <FlatIcon name="save" />
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

function formatAgentPlatform(name: string, agentType: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("claude")) {
    return "Claude Code";
  }
  if (normalized.includes("codex")) {
    return "Codex";
  }
  if (normalized.includes("cursor")) {
    return "Cursor";
  }
  return formatAgentTypeLabel(agentType);
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
  return `${formatCompactNumber(limit.limitValue)} / ${limit.period}`;
}

function formatAgentTokenLimit(limit: ConsoleAgentLimit | undefined): string {
  if (!limit?.enabled) {
    return "Not configured";
  }
  return `${formatCompactNumber(limit.limitValue)} / ${limit.period}`;
}

export async function LimitsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const selectedAgentId = readSingleSearchParam(searchParams.selected);
  const agents = await listAgents(databaseUrl);
  const agentLimits = await listAgentLimits(databaseUrl);
  const agentVirtualModelAccess = await listAgentVirtualModelAccess(databaseUrl);
  const agentLimitsByAgentId = groupByAgentId(agentLimits);
  const accessById = new Map(agentVirtualModelAccess.map((access) => [access.agentId, access]));

  const ruleAgents = agents.filter(
    (agent) => (agentLimitsByAgentId.get(agent.id) ?? []).length > 0,
  );
  const selectedAgent =
    ruleAgents.find((agent) => agent.id === selectedAgentId) ?? ruleAgents[0] ?? agents[0] ?? null;

  const rows = ruleAgents.map((agent) => {
    const limits = agentLimitsByAgentId.get(agent.id) ?? [];
    const summaries = formatAgentLimitSummaries(limits);
    // Usage % and concurrency are not yet tracked by the backend; seeded so the
    // value is stable across renders (real enforcement lands in feat-107).
    const usagePercent = placeholderInt(agent.id, 0, 98, 1);
    const concurrency = placeholderInt(agent.id, 2, 12, 2);
    return { agent, limits, summaries, usagePercent, concurrency };
  });

  const nearBudgetCount = rows.filter((row) => row.usagePercent >= 80).length;

  return (
    <section className="providers-panel" aria-label="Limits">
      <div className="stat-grid">
        <StatCard icon="R" label="Configured rules" value={String(rows.length)} />
        <StatCard
          icon="O"
          label="Over-limit today"
          value={String(placeholderInt("limits-over", 0, 5))}
          delta="placeholder"
        />
        <StatCard icon="B" label="Near budget" value={String(nearBudgetCount)} delta="≥ 80% used" />
        <StatCard
          icon="L"
          label="Rate-limit hits 24h"
          value={String(placeholderInt("limits-rate", 0, 40))}
          delta="placeholder"
        />
      </div>
      <div className="detail-layout">
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Key prefix</th>
                <th className="num">Budget</th>
                <th className="num">Tokens</th>
                <th className="num">RPM</th>
                <th className="num">TPM</th>
                <th className="num">Concurrency</th>
                <th className="num">Usage</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10}>No limit rules configured.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.agent.id}
                    className={selectedAgent?.id === row.agent.id ? "is-selected" : "is-clickable"}
                  >
                    <td>{row.agent.name}</td>
                    <td className="mono">{row.agent.keyPrefix ?? "No key"}</td>
                    <td className="num">{row.summaries.budget}</td>
                    <td className="num">{row.summaries.token}</td>
                    <td className="num">{row.summaries.rpm}</td>
                    <td className="num">{row.summaries.tpm}</td>
                    <td className="num">{row.concurrency}</td>
                    <td className="num">{row.usagePercent}%</td>
                    <td>
                      <LimitUsagePill usagePercent={row.usagePercent} enabled={row.agent.enabled} />
                    </td>
                    <td>
                      <a href={buildQueryHref(searchParams, { selected: row.agent.id })}>Edit</a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {selectedAgent ? (
          <LimitsConfigPanel
            agent={selectedAgent}
            limits={agentLimitsByAgentId.get(selectedAgent.id) ?? []}
            allowedVirtualModels={accessById.get(selectedAgent.id)?.allowedVirtualModels ?? []}
            usagePercent={placeholderInt(selectedAgent.id, 0, 98, 1)}
          />
        ) : null}
      </div>
      <p className="callout callout--warn">
        Current version: requests over budget are throttled gateway-wide; per-rule throttle vs. hard
        block and live concurrency enforcement are not yet supported.
      </p>
    </section>
  );
}

function LimitUsagePill({ usagePercent, enabled }: { usagePercent: number; enabled: boolean }) {
  if (!enabled) {
    return <span className="pill">Disabled</span>;
  }
  if (usagePercent >= 95) {
    return <span className="pill--danger pill">Exceeded</span>;
  }
  if (usagePercent >= 80) {
    return <span className="pill--warn pill">Warning</span>;
  }
  return <span className="pill--ok pill">Normal</span>;
}

function LimitsConfigPanel({
  agent,
  limits,
  allowedVirtualModels,
  usagePercent,
}: {
  agent: { id: string; keyPrefix: string | null; name: string };
  limits: readonly ConsoleAgentLimit[];
  allowedVirtualModels: ReadonlyArray<{ id: string; displayName: string; name: string }>;
  usagePercent: number;
}) {
  const budgetLimit = findAgentLimit(limits, "budget");
  const rpmLimit = findAgentLimit(limits, "rpm");
  const tpmLimit = findAgentLimit(limits, "tpm");
  const tokenLimit = findAgentLimit(limits, "token");
  const usageTone = usagePercent >= 95 ? "is-danger" : usagePercent >= 80 ? "is-warn" : "";

  return (
    <div className="detail-panel">
      <div className="detail-panel-head">
        <h2 className="detail-panel-title">{agent.name}</h2>
        <span className="mono">{agent.keyPrefix ?? "No key"}</span>
      </div>
      <div className="panel-tabs" role="presentation">
        <span className="panel-tab is-active">Budget</span>
        <span className="panel-tab">Rate Limit</span>
        <span className="panel-tab">Allowed Models</span>
      </div>
      <form className="provider-edit-form" action="/api/agent-limits" method="post">
        <input type="hidden" name="action" value="saveLimitRules" />
        <input type="hidden" name="agentId" value={agent.id} />
        <label htmlFor={`limits-budget-${agent.id}`}>Budget USD limit</label>
        <input
          id={`limits-budget-${agent.id}`}
          name="budgetUsd"
          type="number"
          min="0.000001"
          step="0.000001"
          defaultValue={budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd}
          required
        />
        <label htmlFor={`limits-budget-period-${agent.id}`}>Budget period</label>
        <select
          id={`limits-budget-period-${agent.id}`}
          name="budgetPeriod"
          defaultValue={budgetLimit?.period ?? defaultAgentLimitFormValues.budgetPeriod}
          required
        >
          <option value="day">day</option>
          <option value="week">week</option>
          <option value="month">month</option>
        </select>
        <div className="usage-bar">
          <div className="usage-bar-head">
            <span>Current usage</span>
            <span>{usagePercent}%</span>
          </div>
          <div className="usage-bar-track">
            <div
              className={`usage-bar-fill ${usageTone}`.trim()}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>
        <label htmlFor={`limits-rpm-${agent.id}`}>RPM limit</label>
        <input
          id={`limits-rpm-${agent.id}`}
          name="rpm"
          type="number"
          min="1"
          step="1"
          defaultValue={rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm}
          required
        />
        <label htmlFor={`limits-tpm-${agent.id}`}>TPM limit</label>
        <input
          id={`limits-tpm-${agent.id}`}
          name="tpm"
          type="number"
          min="1"
          step="1"
          defaultValue={tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm}
          required
        />
        <label htmlFor={`limits-token-${agent.id}`}>Token limit</label>
        <input
          id={`limits-token-${agent.id}`}
          name="tokenLimit"
          type="number"
          min="1"
          step="1"
          defaultValue={tokenLimit?.limitValue ?? defaultAgentLimitFormValues.tokenLimit}
          required
        />
        <div>
          <p className="detail-section-label">Allowed virtual models</p>
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
        <button type="submit">
          <FlatIcon name="save" />
          <span>Save rule</span>
        </button>
      </form>
    </div>
  );
}

export async function ModelsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const providerModelOptions = await listProviderModelOptions(databaseUrl);
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
  const estimateLabel = isPriced
    ? `Sample estimate: $${(input + output).toFixed(2)}`
    : "Sample estimate: unavailable";

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
          <dt>Estimate</dt>
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
          <FlatIcon name="save" />
          <span>Save price override</span>
        </button>
      </form>
    </div>
  );
}

export async function ProvidersSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const providers = orderProvidersForConsole(await listProviders(databaseUrl));
  const providerHealthSummaries = await listConsoleProviderHealthSummaries({ databaseUrl });
  const providerKeys = await listProviderApiKeyMetadata(databaseUrl);
  const providerModelOptions = orderProviderModelsForConsole(
    await listProviderModelOptions(databaseUrl),
  );
  const providerKeysByProviderId = groupProviderKeysByProviderId(providerKeys);
  const providerHealthByProviderId = new Map(
    providerHealthSummaries.map((summary) => [summary.id, summary]),
  );
  const providerModelsByProviderId = groupProviderModelsByProviderId(providerModelOptions);
  const providerDialog = readSingleSearchParam(searchParams.providerDialog);
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
  const providerFormValues = {
    baseUrl: readSingleSearchParam(searchParams.providerBaseUrlValue) ?? "",
    displayName: readSingleSearchParam(searchParams.providerDisplayNameValue) ?? "",
    providerKey: readSingleSearchParam(searchParams.providerKeyValue) ?? "",
  };
  const providerKeyDialog = readSingleSearchParam(searchParams.providerKeyDialog);
  const providerKeyDelete = readSingleSearchParam(searchParams.providerKeyDelete);
  const providerKeyDialogCloseHref = buildQueryHref(searchParams, {
    providerKeyDelete: undefined,
    providerKeyDialog: undefined,
  });
  const editDialogProvider =
    providerDialog && providerDialog !== "new"
      ? (providers.find((provider) => provider.id === providerDialog) ?? null)
      : null;
  const selectedProviderId = readSingleSearchParam(searchParams.selected);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers.find((provider) => provider.providerKey === "openai") ??
    providers[0] ??
    null;
  const selectedProviderHealth = selectedProvider
    ? providerHealthByProviderId.get(selectedProvider.id)
    : undefined;
  const selectedProviderKeys = selectedProvider
    ? (providerKeysByProviderId.get(selectedProvider.id) ?? [])
    : [];
  const deleteProviderKey = selectedProviderKeys.find(
    (providerKey) => providerKey.id === providerKeyDelete,
  );
  const selectedProviderModels = selectedProvider
    ? (providerModelsByProviderId.get(selectedProvider.id) ?? [])
    : [];

  return (
    <section className="providers-dashboard" aria-label="Providers & Models">
      <div className="provider-card-grid">
        {providers.length === 0 ? (
          <article className="provider-summary-card">
            <div className="provider-summary-head">
              <span className="provider-summary-icon" aria-hidden="true">
                +
              </span>
              <div>
                <h2>No providers</h2>
                <p>Add a provider to begin routing traffic.</p>
              </div>
            </div>
          </article>
        ) : (
          providers.map((provider) => {
            const providerHealth = providerHealthByProviderId.get(provider.id);
            const providerModels = providerModelsByProviderId.get(provider.id) ?? [];
            const providerKeyCount = providerKeysByProviderId.get(provider.id)?.length ?? 0;

            return (
              <article className="provider-summary-card" key={provider.id}>
                <div className="provider-summary-head">
                  <span className="provider-summary-icon" aria-hidden="true">
                    {formatProviderInitials(provider.displayName)}
                  </span>
                  <div>
                    <h2>{provider.displayName}</h2>
                    <ProviderHealthPillZh
                      status={provider.enabled ? (providerHealth?.status ?? "unknown") : "disabled"}
                    />
                  </div>
                </div>
                <dl className="provider-summary-metrics">
                  <div>
                    <dt>Keys</dt>
                    <dd>{formatProviderKeyCount(providerKeyCount)}</dd>
                  </div>
                  <div>
                    <dt>Models</dt>
                    <dd>{providerModels.length}</dd>
                  </div>
                </dl>
              </article>
            );
          })
        )}
      </div>

      <div className="providers-content-grid">
        <div className="providers-main-column">
          <div className="chart-card providers-list-card">
            <h2 className="chart-card-title">Provider 列表</h2>
            {providers.length === 0 ? (
              <p>No providers configured.</p>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table providers-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>状态</th>
                      <th>类型</th>
                      <th className="num">Key 数</th>
                      <th className="num">模型数</th>
                      <th>最近连接</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((provider) => {
                      const providerHealth = providerHealthByProviderId.get(provider.id);
                      const providerModels = providerModelsByProviderId.get(provider.id) ?? [];
                      const providerKeyCount =
                        providerKeysByProviderId.get(provider.id)?.length ?? 0;
                      const providerHref = buildQueryHref(searchParams, {
                        providerDialog: undefined,
                        selected: provider.id,
                      });
                      return (
                        <tr
                          className={
                            provider.id === selectedProvider?.id ? "is-selected" : "is-clickable"
                          }
                          key={provider.id}
                        >
                          <td>
                            <a className="table-row-link" href={providerHref}>
                              <strong>{provider.displayName}</strong>
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={providerHref}>
                              <ProviderHealthPillZh
                                status={
                                  provider.enabled
                                    ? (providerHealth?.status ?? "unknown")
                                    : "disabled"
                                }
                              />
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={providerHref}>
                              {formatProviderType(provider)}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={providerHref}>
                              {providerKeyCount}
                            </a>
                          </td>
                          <td className="num">
                            <a className="table-row-link" href={providerHref}>
                              {providerModels.length}
                            </a>
                          </td>
                          <td>
                            <a className="table-row-link" href={providerHref}>
                              {formatProviderLastConnection(providerHealth)}
                            </a>
                          </td>
                          <td>
                            <span className="provider-table-actions">
                              {provider.enabled ? (
                                <>
                                  <a
                                    className="provider-action-button provider-action-edit"
                                    href={buildQueryHref(searchParams, {
                                      providerDialog: provider.id,
                                      selected: provider.id,
                                    })}
                                    aria-label={`Edit ${provider.displayName}`}
                                    title="Edit"
                                  >
                                    <FlatIcon name="edit" />
                                  </a>
                                  <form action="/api/providers" method="post">
                                    <input type="hidden" name="action" value="disable" />
                                    <input type="hidden" name="id" value={provider.id} />
                                    <button
                                      className="provider-action-button provider-action-delete"
                                      aria-label={`Disable ${provider.displayName}`}
                                      title="Disable"
                                      type="submit"
                                    >
                                      <FlatIcon name="disable" />
                                    </button>
                                  </form>
                                </>
                              ) : (
                                <form action="/api/providers" method="post">
                                  <input type="hidden" name="action" value="enable" />
                                  <input type="hidden" name="id" value={provider.id} />
                                  <button
                                    className="provider-action-button provider-action-enable"
                                    aria-label={`Enable ${provider.displayName}`}
                                    title="Enable"
                                    type="submit"
                                  >
                                    <FlatIcon name="enable" />
                                  </button>
                                </form>
                              )}
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

        <aside className="provider-detail-card" aria-label="Selected provider details">
          {selectedProvider ? (
            <>
              <header className="provider-detail-head">
                <div>
                  <h2>Provider 详情 - {selectedProvider.displayName}</h2>
                </div>
                <form
                  className="provider-refresh-form"
                  action="/api/provider-model-refresh"
                  method="post"
                >
                  <input type="hidden" name="providerId" value={selectedProvider.id} />
                  <button
                    className="provider-refresh-button"
                    disabled={selectedProviderKeys.length === 0}
                    aria-label="Refresh models"
                    title="Refresh models"
                    type="submit"
                  >
                    <FlatIcon name="refresh" />
                  </button>
                  {selectedProviderKeys.length === 0 ? (
                    <p className="field-error is-visible">请先添加 API KEY</p>
                  ) : null}
                </form>
              </header>

              <dl className="provider-detail-stats">
                <div>
                  <dt>状态</dt>
                  <dd>
                    {formatProviderHealthStatusZhLabel(
                      selectedProvider.enabled
                        ? (selectedProviderHealth?.status ?? "unknown")
                        : "disabled",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>默认优先级</dt>
                  <dd>{formatProviderDefaultPriority(providers, selectedProvider)}</dd>
                </div>
                <div>
                  <dt>可用模型</dt>
                  <dd>{selectedProviderModels.length}</dd>
                </div>
                <div>
                  <dt>最近连接</dt>
                  <dd>{formatProviderLastConnection(selectedProviderHealth)}</dd>
                </div>
              </dl>

              <section className="provider-detail-section">
                <div className="provider-detail-section-head">
                  <h3>Key 管理</h3>
                  <a
                    className="provider-key-add-button"
                    href={buildQueryHref(searchParams, {
                      providerKeyDialog: selectedProvider.id,
                    })}
                    aria-label="Add API key"
                    title="Add API key"
                  >
                    <FlatIcon name="key" />
                  </a>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table provider-key-table">
                    <thead>
                      <tr>
                        <th>Prefix</th>
                        <th>状态</th>
                        <th>最近测试</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedProviderKeys.length === 0 ? (
                        <tr>
                          <td colSpan={4}>No provider key stored.</td>
                        </tr>
                      ) : (
                        selectedProviderKeys.map((providerKey) => (
                          <tr key={providerKey.id}>
                            <td className="mono">{providerKey.keyPrefix}</td>
                            <td>
                              <span className="pill--ok pill">启用</span>
                            </td>
                            <td>{formatProviderLastConnection(selectedProviderHealth)}</td>
                            <td>
                              <a
                                className="provider-key-delete-button"
                                href={buildQueryHref(searchParams, {
                                  providerKeyDelete: providerKey.id,
                                })}
                                aria-label="Delete API key"
                                title="Delete API key"
                              >
                                <FlatIcon name="delete" />
                              </a>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <p>No provider selected.</p>
          )}
        </aside>
      </div>

      <div className="chart-card model-library-card">
        <h2 className="chart-card-title">
          模型库{selectedProvider ? ` - ${selectedProvider.displayName}` : ""}
        </h2>
        {selectedProviderModels.length === 0 ? (
          <p>No provider models discovered yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table model-library-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model ID</th>
                  <th>Context</th>
                  <th>输入价格</th>
                  <th>输出价格</th>
                  <th>Tools</th>
                  <th>Streaming</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {selectedProviderModels.map((model) => (
                  <tr key={model.id}>
                    <td>{model.providerDisplayName}</td>
                    <td>
                      <span className="model-id-cell">
                        <strong>{model.modelDisplayName}</strong>
                        <small className="mono">{model.modelId}</small>
                      </span>
                    </td>
                    <td>{formatModelContext(model.contextWindow)}</td>
                    <td>{formatModelPrice(model.inputUsdPerMillionTokens)}</td>
                    <td>{formatModelPrice(model.outputUsdPerMillionTokens)}</td>
                    <td>{formatBooleanFeature(model.supportsTools)}</td>
                    <td>{formatBooleanFeature(model.supportsStreaming)}</td>
                    <td>
                      <ModelAvailabilityPill value={model.availability} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {providerDialog === "new" ? (
        <ProviderCreateDialog
          closeHref={providerDialogCloseHref}
          error={providerError}
          errorField={providerErrorField}
          formValues={providerFormValues}
        />
      ) : null}
      {providerKeyDialog && selectedProvider ? (
        <ProviderKeyCreateDialog
          closeHref={providerKeyDialogCloseHref}
          provider={selectedProvider}
        />
      ) : null}
      {deleteProviderKey && selectedProvider ? (
        <ProviderKeyDeleteDialog
          closeHref={providerKeyDialogCloseHref}
          keyPrefix={deleteProviderKey.keyPrefix}
          provider={selectedProvider}
        />
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
          <h2 id="new-provider-dialog-title">添加 Provider</h2>
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
          <h2 id="edit-provider-dialog-title">编辑 {provider.displayName}</h2>
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
            <FlatIcon name="save" />
            <span>Save provider</span>
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
          <h2 id="provider-key-create-title">新增 {provider.displayName} API key</h2>
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
          <button type="submit">
            <FlatIcon name="key" />
            <span>Save API key</span>
          </button>
        </form>
      </section>
    </>
  );
}

function ProviderKeyDeleteDialog({
  closeHref,
  keyPrefix,
  provider,
}: {
  closeHref: string;
  keyPrefix: string;
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
          <button className="agent-delete-confirm" type="button">
            <FlatIcon name="delete" />
            <span>Delete</span>
          </button>
        </div>
      </section>
    </>
  );
}

export async function SettingsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const configImportVersion = readSingleSearchParam(searchParams.configImportVersion);
  const notificationChannels = await listNotificationChannels(databaseUrl);
  return (
    <section className="providers-panel" id="settings" aria-label="Settings">
      <div className="settings-layout">
        <nav className="settings-subnav" aria-label="Settings sections">
          <a href="#settings-general">General</a>
          <a href="#settings-security">Security</a>
          <a href="#settings-data">Data</a>
          <a href="#notification-channels">Notifications</a>
          <a href="#settings-danger">Danger Zone</a>
        </nav>
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
                  <option value="zh">中文</option>
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
                <dd>Set</dd>
              </div>
              <div className="detail-field">
                <dt>Login</dt>
                <dd>Enabled</dd>
              </div>
              <div className="detail-field">
                <dt>Public access</dt>
                <dd>Read-only reminder</dd>
              </div>
            </dl>
            <p className="callout">
              Password change and session management are managed via deployment configuration.
            </p>
          </section>

          <section
            className="settings-panel"
            id="settings-data"
            aria-labelledby="settings-data-title"
          >
            <h3 id="settings-data-title">Data</h3>
            {configImportVersion ? (
              <p className="status-enabled">
                Config import published version v{configImportVersion}
              </p>
            ) : null}
            <div className="settings-grid">
              <article className="card">
                <h4>Export config</h4>
                <p>Providers, Models, Virtual Models, Agents, Limits.</p>
                <a className="secondary-button" download href="/api/config-export">
                  <FlatIcon name="export" />
                  <span>Export redacted config</span>
                </a>
              </article>
              <article className="card">
                <h4>Export request metadata</h4>
                <p>Metadata only — no prompt / response content.</p>
                <button className="secondary-button" type="button" disabled>
                  <FlatIcon name="export" />
                  <span>Export CSV</span>
                </button>
              </article>
              <article className="card">
                <h4>Export cost report</h4>
                <p>Aggregated by Agent, Provider, Model.</p>
                <button className="secondary-button" type="button" disabled>
                  <FlatIcon name="export" />
                  <span>Export report</span>
                </button>
              </article>
            </div>
            <form className="provider-create-form" action="/api/config-import" method="post">
              <label htmlFor="config-import-json">Config import JSON</label>
              <textarea id="config-import-json" name="configJson" required rows={8} />
              <button type="submit">
                <FlatIcon name="import" />
                <span>Import redacted config</span>
              </button>
            </form>
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
                <input type="hidden" name="channelType" value="email" />
                <label htmlFor="notification-email-name">Email channel name</label>
                <input id="notification-email-name" name="displayName" required />
                <label htmlFor="notification-email-to">Email to</label>
                <input id="notification-email-to" name="emailTo" type="email" required />
                <label htmlFor="notification-email-from">Email from</label>
                <input id="notification-email-from" name="emailFrom" type="email" required />
                <button type="submit">
                  <FlatIcon name="add" />
                  <span>Create email notification channel</span>
                </button>
              </form>
              <form
                className="provider-create-form"
                action="/api/notification-channels"
                method="post"
              >
                <input type="hidden" name="action" value="create" />
                <input type="hidden" name="channelType" value="webhook" />
                <label htmlFor="notification-webhook-name">Webhook channel name</label>
                <input id="notification-webhook-name" name="displayName" required />
                <label htmlFor="notification-webhook-url">Webhook URL</label>
                <input id="notification-webhook-url" name="webhookUrl" type="url" required />
                <button type="submit">
                  <FlatIcon name="add" />
                  <span>Create webhook notification channel</span>
                </button>
              </form>
            </div>
          </section>

          <section
            className="settings-panel settings-danger"
            id="settings-danger"
            aria-labelledby="settings-danger-title"
          >
            <h3 id="settings-danger-title">Danger Zone</h3>
            <ul className="danger-list">
              <li>
                <div>
                  <p className="danger-action">Delete Provider Key</p>
                  <p>Irreversible.</p>
                </div>
                <button className="secondary-button" type="button" disabled>
                  <FlatIcon name="delete" />
                  <span>Delete</span>
                </button>
              </li>
              <li>
                <div>
                  <p className="danger-action">Delete Agent</p>
                  <p>Removes related API keys.</p>
                </div>
                <button className="secondary-button" type="button" disabled>
                  <FlatIcon name="delete" />
                  <span>Delete</span>
                </button>
              </li>
              <li>
                <div>
                  <p className="danger-action">Clear request metadata</p>
                  <p>Keeps configuration data.</p>
                </div>
                <button className="secondary-button" type="button" disabled>
                  <FlatIcon name="delete" />
                  <span>Delete</span>
                </button>
              </li>
            </ul>
            <p className="callout callout--warn">
              Destructive actions are managed per-resource on their module pages.
            </p>
          </section>
        </div>
      </div>
    </section>
  );
}

function formatNotificationChannelConfig(channel: ConsoleNotificationChannel): string {
  if (channel.channelType === "email") {
    const config = channel.config as { from?: string; to?: string };
    return `Email: ${config.from ?? "unknown sender"} to ${config.to ?? "unknown recipient"}`;
  }

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

function formatActivityModelHitLabel(activity: ConsoleActivity): string {
  const displayName = activity.providerModelDisplayName ?? "Unknown model";
  const modelName = activity.providerModelName ?? activity.providerModelId ?? "unknown";
  return `${displayName} (${modelName})`;
}

function formatRoutePolicyCandidateList(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate) => candidate.optionLabel).join(", ");
}

function formatDefaultCandidate(routePolicy: ConsoleRoutePolicy | null | undefined): string {
  return routePolicy?.primaryCandidates[0]?.modelDisplayName ?? "-";
}

function formatVirtualModelCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatRouteStrategyLabel(strategy: string): string {
  if (strategy === "cost_first") {
    return "Cost First";
  }
  if (strategy === "quality_first") {
    return "Quality First";
  }
  return strategy.charAt(0).toUpperCase() + strategy.slice(1);
}

function formatRoutePolicyFallbackOrder(candidates: Array<{ optionLabel: string }>): string {
  return candidates.length === 0
    ? "None"
    : candidates.map((candidate, index) => `${index + 1}. ${candidate.optionLabel}`).join(" -> ");
}

function providerModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
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

function groupProviderModelsByProviderId(
  providerModels: Awaited<ReturnType<typeof listProviderModelOptions>>,
) {
  const grouped = new Map<string, typeof providerModels>();

  for (const providerModel of providerModels) {
    const models = grouped.get(providerModel.providerId) ?? [];
    models.push(providerModel);
    grouped.set(providerModel.providerId, models);
  }

  return grouped;
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

function formatProviderInitials(displayName: string): string {
  const initials = displayName
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z0-9]/gi, "").charAt(0))
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return initials || displayName.slice(0, 2).toUpperCase();
}

function formatProviderType(provider: ConsoleProvider): string {
  if (provider.providerType === "local") {
    return "Local";
  }
  return provider.providerTemplateId ? "Template" : "API Key";
}

function formatProviderKeyCount(count: number): string {
  if (count === 0) {
    return "-";
  }
  return count === 1 ? "1 Key" : `${count} Keys`;
}

function formatProviderDefaultPriority(
  providers: readonly ConsoleProvider[],
  selectedProvider: ConsoleProvider,
): string {
  const index = providers.findIndex((provider) => provider.id === selectedProvider.id);
  return index >= 0 ? String(index + 1) : "-";
}

function formatProviderLastConnection(
  providerHealth: ConsoleProviderHealthSummary | undefined,
): string {
  if (!providerHealth?.latestProbeAt) {
    return "-";
  }

  return formatRelativeDateTime(providerHealth.latestProbeAt);
}

function formatRelativeDateTime(value: Date): string {
  const elapsedMs = Date.now() - value.getTime();
  if (elapsedMs < 60_000) {
    return "刚刚";
  }
  if (elapsedMs < 3_600_000) {
    return `${Math.floor(elapsedMs / 60_000)} 分钟前`;
  }
  if (elapsedMs < 86_400_000) {
    return `${Math.floor(elapsedMs / 3_600_000)} 小时前`;
  }
  return value.toISOString().slice(0, 10);
}

function formatModelContext(contextWindow: number | null): string {
  if (contextWindow === null) {
    return "Unknown";
  }
  if (contextWindow >= 1_000_000) {
    return `${formatDecimal(contextWindow / 1_000_000)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${formatDecimal(contextWindow / 1_000)}K`;
  }
  return String(contextWindow);
}

function formatModelPrice(price: number | null): string {
  if (price === null) {
    return "未知";
  }
  const digits = price >= 1 ? 2 : 4;
  return `$${price.toFixed(digits)}`;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBooleanFeature(value: boolean): string {
  return value ? "支持" : "不支持";
}

function formatModelAvailability(value: string): string {
  if (value === "available") {
    return "启用";
  }
  if (value === "disabled") {
    return "禁用";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function virtualModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
}

function formatVirtualModelOptionLabel(virtualModel: {
  description?: string;
  displayName?: string;
  name: string;
}): string {
  const label = virtualModel.description ?? virtualModel.displayName ?? virtualModel.name;
  return `${label} (${virtualModel.name})`;
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
