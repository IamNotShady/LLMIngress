import {
  calculateTokenCostUsd,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import {
  type ConsoleActivity,
  formatConsoleActivityCost,
  formatConsoleActivityFallbackAttempts,
  formatConsoleActivityRouteReason,
  listConsoleActivities,
} from "../../server/activity";
import {
  formatAgentApiKeyVirtualModelAccess,
  listAgentApiKeyMetadata,
  listAgentApiKeyVirtualModelAccess,
} from "../../server/agent-api-keys";
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
import { listAgents } from "../../server/agents";
import { getConsoleDatabaseUrl } from "../../server/auth";
import { placeholderFloat, placeholderInt, placeholderTrend } from "../../server/mock-data";
import {
  type ConsoleNotificationChannel,
  listNotificationChannels,
} from "../../server/notification-channels";
import { getManualPriceOverride } from "../../server/price-overrides";
import {
  type ConsoleProviderHealthSummary,
  formatProviderHealthFailureCount,
  formatProviderHealthLatestProbe,
  formatProviderHealthStaleStatus,
  formatProviderHealthStatus,
  listConsoleProviderHealthSummaries,
} from "../../server/provider-health";
import { listProviderApiKeyMetadata } from "../../server/provider-keys";
import {
  listProviderTemplateSelectorGroups,
  type ProviderTemplateSelectorItem,
} from "../../server/provider-templates";
import { listProviders } from "../../server/providers";
import {
  buildRoutePolicyHealthWarnings,
  filterRoutePolicyEditorProviderModelOptions,
  listProviderModelOptions,
  listRoutePolicies,
  mergeRoutePolicyEditorProviderModelOptions,
  normalizeRoutePolicyEditorFilters,
  routePolicyStrategies,
} from "../../server/route-policies";
import {
  formatGatewayHeartbeatStatus,
  formatRuntimeErrorEntry,
  formatRuntimeReloadResult,
  getConsoleRuntimeSnapshot,
} from "../../server/runtime";
import {
  type ConsoleUsageDimensionBreakdown,
  formatConsoleUsageCost,
  getConsoleUsageSummary,
  parseConsoleUsageWindow,
} from "../../server/usage";
import { listVirtualModels } from "../../server/virtual-models";
import { DonutBreakdown } from "../_components/charts/donut-breakdown";
import { chartAccent, chartOk } from "../_components/charts/palette";
import { TrendLineChart } from "../_components/charts/trend-line-chart";
import { Disclosure, Pager, Row } from "../_components/list-ui";
import { StatCard } from "../_components/stat-card";
import { buildQueryHref, paginate, readPageParam } from "../_lib/pagination";

export type ConsoleSearchParams = Record<string, string | string[] | undefined>;

const previewProviderKey = "openai";
const previewModelId = "gpt-4.1-mini";
const providerTemplateGroups = listProviderTemplateSelectorGroups();
const remoteProviderTemplateGroup = requireProviderTemplateGroup("remote_api_key");
const localProviderTemplateGroup = requireProviderTemplateGroup("local");

export async function OverviewSection() {
  const databaseUrl = getConsoleDatabaseUrl();
  const usageSummary = await getConsoleUsageSummary({ databaseUrl, window: "24h" });
  const activities = await listConsoleActivities(databaseUrl);
  const agents = await listAgents(databaseUrl);
  const runtimeSnapshot = await getConsoleRuntimeSnapshot(databaseUrl);
  const gateway = runtimeSnapshot.gateways[0] ?? null;

  const recentActivities = activities.slice(0, 8);
  const onlineAgents = agents.filter((agent) => agent.enabled).length;
  const failureRate =
    usageSummary.requestCount > 0
      ? `${((usageSummary.failureCount / usageSummary.requestCount) * 100).toFixed(2)}%`
      : "0.00%";
  const trend = placeholderTrend("overview-trend", 14);
  const topAgents = usageSummary.agentBreakdowns
    .slice(0, 5)
    .map((breakdown) => ({ name: breakdown.label, value: breakdown.requestCount }));

  return (
    <section className="providers-panel" aria-label="Overview">
      <div className="stat-grid">
        <StatCard
          icon="RQ"
          label="Requests today"
          value={formatCompactNumber(usageSummary.requestCount)}
        />
        <StatCard
          icon="$"
          label="Cost today"
          value={formatConsoleUsageCost(usageSummary.totalCostUsd)}
        />
        <StatCard
          icon="TK"
          label="Tokens today"
          value={formatCompactNumber(usageSummary.totalTokens)}
        />
        <StatCard icon="FR" label="Failure rate" value={failureRate} />
        <StatCard
          icon="SV"
          label="Savings"
          value={formatConsoleUsageCost(usageSummary.totalSavingsUsd)}
        />
        <StatCard icon="AG" label="Online agents" value={String(onlineAgents)} />
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
                    <th>Request</th>
                    <th>Provider</th>
                    <th>Model</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                    <th className="num">Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentActivities.map((activity) => (
                    <tr key={activity.id}>
                      <td className="mono">{activity.requestId.slice(0, 10)}</td>
                      <td>{formatActivityProviderLabel(activity)}</td>
                      <td>{formatActivityModelSummary(activity)}</td>
                      <td className="num">{formatCompactNumber(activity.totalTokens ?? 0)}</td>
                      <td className="num">{formatConsoleActivityCost(activity.totalCostUsd)}</td>
                      <td className="num">{formatActivityLatency(activity.latencyMs)}</td>
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
          <dl className="detail-field-list">
            <div className="detail-field">
              <dt>Instance</dt>
              <dd>{gateway?.gatewayInstanceId ?? "No gateway"}</dd>
            </div>
            <div className="detail-field">
              <dt>Config version</dt>
              <dd>{formatConfigVersion(gateway?.appliedConfigVersion ?? null)}</dd>
            </div>
            <div className="detail-field">
              <dt>Last heartbeat</dt>
              <dd>{formatNullableDateTime(gateway?.heartbeatAt ?? null)}</dd>
            </div>
            <div className="detail-field">
              <dt>Schema version</dt>
              <dd>{runtimeSnapshot.migrations.currentSchemaVersion ?? "—"}</dd>
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
          <h2 className="chart-card-title">Top agents</h2>
          {topAgents.length === 0 ? (
            <p>No agent activity recorded.</p>
          ) : (
            <DonutBreakdown ariaLabel="Top agents by requests" data={topAgents} />
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

function formatActivityLatency(latencyMs: number | null): string {
  if (latencyMs === null) {
    return "—";
  }
  return `${(latencyMs / 1000).toFixed(2)}s`;
}

function ActivityStatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") {
    return <span className="pill--ok pill">{status}</span>;
  }
  if (normalized === "error" || normalized === "failed" || normalized === "failure") {
    return <span className="pill--danger pill">{status}</span>;
  }
  return <span className="pill">{status}</span>;
}

export async function RuntimeSection() {
  const databaseUrl = getConsoleDatabaseUrl();
  const runtimeSnapshot = await getConsoleRuntimeSnapshot(databaseUrl);
  return (
    <section className="providers-panel" id="runtime" aria-labelledby="runtime-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Gateway</p>
          <h2 id="runtime-title">Runtime</h2>
        </div>
      </div>
      {runtimeSnapshot.gateways.length === 0 ? (
        <p>No gateway runtime status recorded.</p>
      ) : (
        <div className="runtime-grid">
          {runtimeSnapshot.gateways.map((gateway) => (
            <article className="runtime-item" key={gateway.gatewayInstanceId}>
              <h3>Gateway: {gateway.gatewayInstanceId}</h3>
              <p>Heartbeat: {formatGatewayHeartbeatStatus({ heartbeatAt: gateway.heartbeatAt })}</p>
              <p>Gateway status: {gateway.status}</p>
              <p>Applied config version: {formatConfigVersion(gateway.appliedConfigVersion)}</p>
              <p>Target config version: {formatConfigVersion(gateway.targetConfigVersion)}</p>
              <p>{formatRuntimeReloadResult(gateway)}</p>
              {gateway.lastReloadError && gateway.lastReloadStatus !== "failed" ? (
                <p>Reload error: {gateway.lastReloadError}</p>
              ) : null}
              <p>Last heartbeat: {formatNullableDateTime(gateway.heartbeatAt)}</p>
            </article>
          ))}
        </div>
      )}
      <div className="runtime-errors">
        <h3>Migration status</h3>
        <p>
          Current schema: {runtimeSnapshot.migrations.currentSchemaVersion ?? "not initialized"}
        </p>
        <p>
          Latest migration:{" "}
          {runtimeSnapshot.migrations.latestMigrationId &&
          runtimeSnapshot.migrations.latestMigrationName
            ? `${runtimeSnapshot.migrations.latestMigrationId}_${runtimeSnapshot.migrations.latestMigrationName}`
            : "none"}
        </p>
        <p>
          Applied migrations: {runtimeSnapshot.migrations.appliedCount}/
          {runtimeSnapshot.migrations.totalCount}
        </p>
        <p>
          Pending migrations:{" "}
          {runtimeSnapshot.migrations.pendingMigrations.length === 0
            ? "none"
            : runtimeSnapshot.migrations.pendingMigrations
                .map((migration) => `${migration.id}_${migration.name}`)
                .join(", ")}
        </p>
        <p>
          db:migrate:check health:{" "}
          {runtimeSnapshot.migrations.migrateCheckHealth.status === "ready" ? "Ready" : "Blocked"} -{" "}
          {runtimeSnapshot.migrations.migrateCheckHealth.message}
        </p>
      </div>
      <div className="runtime-errors">
        <h3>Recent runtime errors</h3>
        {runtimeSnapshot.errors.length === 0 ? (
          <p>No runtime errors recorded.</p>
        ) : (
          <ul>
            {runtimeSnapshot.errors.map((error) => (
              <li
                key={`${error.processType}:${error.processId}:${error.errorCode}:${error.createdAt.toISOString()}`}
              >
                {formatRuntimeErrorEntry(error)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
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
          <button type="submit">Apply</button>
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
  return (
    <DonutBreakdown
      ariaLabel={`${label} cost breakdown`}
      data={slices}
      valueFormatter={(value) => `$${value.toFixed(2)}`}
    />
  );
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
          <button type="submit">Apply</button>
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
                            {activity.requestId.slice(0, 12)}
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
  const view = paginate(virtualModels, readPageParam(searchParams));
  return (
    <section className="providers-panel" aria-label="Virtual models">
      <Disclosure tone="add" summary="New virtual model">
        <form className="provider-create-form" action="/api/virtual-models" method="post">
          <input type="hidden" name="action" value="create" />
          <label htmlFor="virtual-model-name">Virtual model name</label>
          <input id="virtual-model-name" name="name" required />
          <label htmlFor="virtual-model-display-name">Virtual model display name</label>
          <input id="virtual-model-display-name" name="displayName" required />
          <button type="submit">Create virtual model</button>
        </form>
      </Disclosure>
      {virtualModels.length === 0 ? (
        <p>No virtual models configured.</p>
      ) : (
        <div className="row-list">
          {view.items.map((virtualModel) => (
            <Row
              key={virtualModel.id}
              title={<h3 className="row-title">{virtualModel.displayName}</h3>}
              meta={
                <span className="row-meta">
                  <span className="mono">{virtualModel.name}</span>
                  <span>{virtualModel.routePolicyCount} route policies</span>
                  <span>{virtualModel.allowedApiKeyCount} allowed keys</span>
                </span>
              }
              status={
                <span className={virtualModel.enabled ? "status-enabled" : "status-disabled"}>
                  {virtualModel.enabled ? "Enabled" : "Disabled"}
                </span>
              }
            >
              <form className="provider-edit-form" action="/api/virtual-models" method="post">
                <input type="hidden" name="action" value="update" />
                <input type="hidden" name="id" value={virtualModel.id} />
                <label htmlFor={`virtual-model-name-${virtualModel.id}`}>
                  Edit virtual model name
                </label>
                <input
                  id={`virtual-model-name-${virtualModel.id}`}
                  name="name"
                  defaultValue={virtualModel.name}
                  required
                />
                <label htmlFor={`virtual-model-display-${virtualModel.id}`}>
                  Edit virtual model display name
                </label>
                <input
                  id={`virtual-model-display-${virtualModel.id}`}
                  name="displayName"
                  defaultValue={virtualModel.displayName}
                  required
                />
                <button type="submit">Save virtual model</button>
              </form>
              <p>Route policies: {virtualModel.routePolicyCount}</p>
              <p>Default Agent API keys: {virtualModel.defaultApiKeyCount}</p>
              <p>Allowed Agent API keys: {virtualModel.allowedApiKeyCount}</p>
              <div className="row-actions">
                <form action="/api/virtual-models" method="post">
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="id" value={virtualModel.id} />
                  <button className="secondary-button" type="submit">
                    Delete virtual model
                  </button>
                </form>
              </div>
            </Row>
          ))}
        </div>
      )}
      <Pager view={view} searchParams={searchParams} />
    </section>
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
          <button type="submit">Apply route policy filters</button>
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
                  {virtualModel.displayName} ({virtualModel.name})
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
            <button type="submit">Create route policy</button>
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
                  <button type="submit">Save route policy</button>
                </form>
                <div className="row-actions">
                  <form action="/api/route-policies" method="post">
                    <input type="hidden" name="action" value="delete" />
                    <input type="hidden" name="id" value={routePolicy.id} />
                    <button className="secondary-button" type="submit">
                      Delete route policy
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
  const agents = await listAgents(databaseUrl);
  const agentApiKeys = await listAgentApiKeyMetadata(databaseUrl);
  const agentApiKeyVirtualModelAccess = await listAgentApiKeyVirtualModelAccess(databaseUrl);
  const agentLimits = await listAgentLimits(databaseUrl);
  const virtualModels = await listVirtualModels(databaseUrl);
  const agentApiKeysByAgentId = groupByAgentId(agentApiKeys);
  const agentApiKeyVirtualModelAccessById = new Map(
    agentApiKeyVirtualModelAccess.map((access) => [access.agentApiKeyId, access]),
  );
  const agentLimitsByApiKeyId = groupByAgentApiKeyId(agentLimits);
  const view = paginate(agents, readPageParam(searchParams));
  return (
    <section className="providers-panel" aria-label="Agents">
      <Disclosure tone="add" summary="New agent">
        <form className="provider-create-form" action="/api/agents" method="post">
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
          <button type="submit">Create agent</button>
        </form>
      </Disclosure>
      {agents.length === 0 ? (
        <p>No agents configured.</p>
      ) : (
        <div className="row-list">
          {view.items.map((agent) => (
            <Row
              key={agent.id}
              title={<h3 className="row-title">{agent.name}</h3>}
              meta={
                <span className="row-meta">
                  <span>Type: {agent.agentType}</span>
                  <span>{agent.activeApiKeyCount} active keys</span>
                </span>
              }
              status={
                <span className={agent.enabled ? "status-enabled" : "status-disabled"}>
                  {agent.enabled ? "Enabled" : "Disabled"}
                </span>
              }
            >
              <form className="provider-edit-form" action="/api/agents" method="post">
                <input type="hidden" name="action" value="update" />
                <input type="hidden" name="id" value={agent.id} />
                <label htmlFor={`agent-name-${agent.id}`}>Edit agent name</label>
                <input
                  id={`agent-name-${agent.id}`}
                  name="name"
                  defaultValue={agent.name}
                  required
                />
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
                <button type="submit">Save agent</button>
              </form>
              <p>Active API keys: {agent.activeApiKeyCount}</p>
              <p>Request attribution records: {agent.requestAttributionCount}</p>
              <div className="provider-key-metadata">
                {(agentApiKeysByAgentId.get(agent.id) ?? []).length === 0 ? (
                  <p>No Agent API keys saved.</p>
                ) : (
                  (agentApiKeysByAgentId.get(agent.id) ?? []).map((agentApiKey) => {
                    const access = agentApiKeyVirtualModelAccessById.get(agentApiKey.id) ?? {
                      agentApiKeyId: agentApiKey.id,
                      allowedVirtualModels: [],
                      defaultVirtualModel: null,
                    };
                    const accessLabels = formatAgentApiKeyVirtualModelAccess(access);
                    const limits = agentLimitsByApiKeyId.get(agentApiKey.id) ?? [];
                    const limitSummaries = formatAgentLimitSummaries(limits);
                    const budgetLimit = findAgentLimit(limits, "budget");
                    const rpmLimit = findAgentLimit(limits, "rpm");
                    const tokenLimit = findAgentLimit(limits, "token");
                    const tpmLimit = findAgentLimit(limits, "tpm");
                    const integrationTemplates = buildAgentIntegrationTemplates({
                      apiKey: formatDashboardAgentApiKeySnippetValue(agentApiKey.keyPrefix),
                      gatewayBaseUrl: playgroundGatewayBaseUrl,
                      model: resolveAgentIntegrationModelName(access),
                    });

                    return (
                      <div className="key-block" key={agentApiKey.id}>
                        <p>Agent API key prefix: {agentApiKey.keyPrefix}</p>
                        <p>Agent API key status: {agentApiKey.enabled ? "Enabled" : "Disabled"}</p>
                        <p>Agent API key created: {formatDateTime(agentApiKey.createdAt)}</p>
                        <p>Agent API key updated: {formatDateTime(agentApiKey.updatedAt)}</p>
                        <p>Allowed Virtual Models: {accessLabels.allowedLabel}</p>
                        <p>Default Virtual Model: {accessLabels.defaultLabel}</p>
                        <Disclosure summary="Integration snippets">
                          <fieldset className="agent-integration-snippets">
                            <legend>Agent integration snippets</legend>
                            {integrationTemplates.map((template) => (
                              <div className="agent-integration-snippet" key={template.id}>
                                <label htmlFor={`${template.id}-setup-snippet-${agentApiKey.id}`}>
                                  {template.displayName} setup snippet
                                </label>
                                <textarea
                                  id={`${template.id}-setup-snippet-${agentApiKey.id}`}
                                  readOnly
                                  rows={4}
                                  defaultValue={template.snippet}
                                />
                              </div>
                            ))}
                          </fieldset>
                        </Disclosure>
                        <form
                          className="provider-edit-form"
                          action="/api/agent-api-keys"
                          method="post"
                        >
                          <input type="hidden" name="action" value="updateVirtualModelAccess" />
                          <input type="hidden" name="id" value={agentApiKey.id} />
                          <label htmlFor={`agent-key-allowed-virtual-models-${agentApiKey.id}`}>
                            Allowed virtual models
                          </label>
                          <select
                            id={`agent-key-allowed-virtual-models-${agentApiKey.id}`}
                            name="allowedVirtualModelIds"
                            defaultValue={access.allowedVirtualModels.map(
                              (virtualModel) => virtualModel.id,
                            )}
                            multiple
                            size={virtualModelSelectSize(virtualModels.length)}
                          >
                            {virtualModels.map((virtualModel) => (
                              <option key={virtualModel.id} value={virtualModel.id}>
                                {formatVirtualModelOptionLabel(virtualModel)}
                              </option>
                            ))}
                          </select>
                          <label htmlFor={`agent-key-default-virtual-model-${agentApiKey.id}`}>
                            Default virtual model
                          </label>
                          <select
                            id={`agent-key-default-virtual-model-${agentApiKey.id}`}
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
                          <button type="submit">Save Agent API key virtual models</button>
                        </form>
                        <p>Budget Limit: {limitSummaries.budget}</p>
                        <p>RPM Limit: {limitSummaries.rpm}</p>
                        <p>TPM Limit: {limitSummaries.tpm}</p>
                        <p>Token Limit: {limitSummaries.token}</p>
                        <form
                          className="provider-edit-form"
                          action="/api/agent-limits"
                          method="post"
                        >
                          <input type="hidden" name="action" value="saveLimitRules" />
                          <input type="hidden" name="agentApiKeyId" value={agentApiKey.id} />
                          <label htmlFor={`agent-key-budget-usd-${agentApiKey.id}`}>
                            Budget USD limit
                          </label>
                          <input
                            id={`agent-key-budget-usd-${agentApiKey.id}`}
                            name="budgetUsd"
                            type="number"
                            min="0.000001"
                            step="0.000001"
                            defaultValue={
                              budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd
                            }
                            required
                          />
                          <label htmlFor={`agent-key-budget-period-${agentApiKey.id}`}>
                            Budget period
                          </label>
                          <select
                            id={`agent-key-budget-period-${agentApiKey.id}`}
                            name="budgetPeriod"
                            defaultValue={
                              budgetLimit?.period ?? defaultAgentLimitFormValues.budgetPeriod
                            }
                            required
                          >
                            <option value="day">day</option>
                            <option value="week">week</option>
                            <option value="month">month</option>
                          </select>
                          <label htmlFor={`agent-key-rpm-${agentApiKey.id}`}>RPM limit</label>
                          <input
                            id={`agent-key-rpm-${agentApiKey.id}`}
                            name="rpm"
                            type="number"
                            min="1"
                            step="1"
                            defaultValue={rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm}
                            required
                          />
                          <label htmlFor={`agent-key-tpm-${agentApiKey.id}`}>TPM limit</label>
                          <input
                            id={`agent-key-tpm-${agentApiKey.id}`}
                            name="tpm"
                            type="number"
                            min="1"
                            step="1"
                            defaultValue={tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm}
                            required
                          />
                          <label htmlFor={`agent-key-token-limit-${agentApiKey.id}`}>
                            Token limit
                          </label>
                          <input
                            id={`agent-key-token-limit-${agentApiKey.id}`}
                            name="tokenLimit"
                            type="number"
                            min="1"
                            step="1"
                            defaultValue={
                              tokenLimit?.limitValue ?? defaultAgentLimitFormValues.tokenLimit
                            }
                            required
                          />
                          <button type="submit">Save Agent API key limits</button>
                        </form>
                        <div className="row-actions">
                          <form action="/api/agent-api-keys" method="post">
                            <input type="hidden" name="action" value="rotate" />
                            <input type="hidden" name="id" value={agentApiKey.id} />
                            <button type="submit">Rotate Agent API key</button>
                          </form>
                          {agentApiKey.enabled ? (
                            <form action="/api/agent-api-keys" method="post">
                              <input type="hidden" name="action" value="disable" />
                              <input type="hidden" name="id" value={agentApiKey.id} />
                              <button className="secondary-button" type="submit">
                                Disable Agent API key
                              </button>
                            </form>
                          ) : null}
                          <form action="/api/agent-api-keys" method="post">
                            <input type="hidden" name="action" value="delete" />
                            <input type="hidden" name="id" value={agentApiKey.id} />
                            <button className="secondary-button" type="submit">
                              Delete Agent API key
                            </button>
                          </form>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="row-actions">
                <form className="provider-key-form" action="/api/agent-api-keys" method="post">
                  <input type="hidden" name="action" value="create" />
                  <input type="hidden" name="agentId" value={agent.id} />
                  <button type="submit">Create Agent API key</button>
                </form>
                <form action="/api/agents" method="post">
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="id" value={agent.id} />
                  <button className="secondary-button" type="submit">
                    Delete agent
                  </button>
                </form>
              </div>
            </Row>
          ))}
        </div>
      )}
      <Pager view={view} searchParams={searchParams} />
    </section>
  );
}

export async function LimitsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const selectedKeyId = readSingleSearchParam(searchParams.selected);
  const agents = await listAgents(databaseUrl);
  const agentApiKeys = await listAgentApiKeyMetadata(databaseUrl);
  const agentLimits = await listAgentLimits(databaseUrl);
  const agentApiKeyVirtualModelAccess = await listAgentApiKeyVirtualModelAccess(databaseUrl);
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const agentLimitsByApiKeyId = groupByAgentApiKeyId(agentLimits);
  const accessById = new Map(
    agentApiKeyVirtualModelAccess.map((access) => [access.agentApiKeyId, access]),
  );

  // Only keys with at least one configured limit are "rules" in the mockup.
  const ruleKeys = agentApiKeys.filter(
    (key) => (agentLimitsByApiKeyId.get(key.id) ?? []).length > 0,
  );
  const selectedKey =
    ruleKeys.find((key) => key.id === selectedKeyId) ?? ruleKeys[0] ?? agentApiKeys[0] ?? null;

  const rows = ruleKeys.map((key) => {
    const limits = agentLimitsByApiKeyId.get(key.id) ?? [];
    const summaries = formatAgentLimitSummaries(limits);
    // Usage % and concurrency are not yet tracked by the backend; seeded so the
    // value is stable across renders (real enforcement lands in feat-107).
    const usagePercent = placeholderInt(key.id, 0, 98, 1);
    const concurrency = placeholderInt(key.id, 2, 12, 2);
    return { key, limits, summaries, usagePercent, concurrency };
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
                <th>API key</th>
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
                    key={row.key.id}
                    className={selectedKey?.id === row.key.id ? "is-selected" : "is-clickable"}
                  >
                    <td>{agentNameById.get(row.key.agentId) ?? "Unknown agent"}</td>
                    <td className="mono">{row.key.keyPrefix}</td>
                    <td className="num">{row.summaries.budget}</td>
                    <td className="num">{row.summaries.token}</td>
                    <td className="num">{row.summaries.rpm}</td>
                    <td className="num">{row.summaries.tpm}</td>
                    <td className="num">{row.concurrency}</td>
                    <td className="num">{row.usagePercent}%</td>
                    <td>
                      <LimitUsagePill usagePercent={row.usagePercent} enabled={row.key.enabled} />
                    </td>
                    <td>
                      <a href={buildQueryHref(searchParams, { selected: row.key.id })}>Edit</a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {selectedKey ? (
          <LimitsConfigPanel
            agentApiKey={selectedKey}
            agentName={agentNameById.get(selectedKey.agentId) ?? "Unknown agent"}
            limits={agentLimitsByApiKeyId.get(selectedKey.id) ?? []}
            allowedVirtualModels={accessById.get(selectedKey.id)?.allowedVirtualModels ?? []}
            usagePercent={placeholderInt(selectedKey.id, 0, 98, 1)}
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
  agentApiKey,
  agentName,
  limits,
  allowedVirtualModels,
  usagePercent,
}: {
  agentApiKey: { id: string; keyPrefix: string };
  agentName: string;
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
        <h2 className="detail-panel-title">{agentName}</h2>
        <span className="mono">{agentApiKey.keyPrefix}</span>
      </div>
      <div className="panel-tabs" role="presentation">
        <span className="panel-tab is-active">Budget</span>
        <span className="panel-tab">Rate Limit</span>
        <span className="panel-tab">Allowed Models</span>
      </div>
      <form className="provider-edit-form" action="/api/agent-limits" method="post">
        <input type="hidden" name="action" value="saveLimitRules" />
        <input type="hidden" name="agentApiKeyId" value={agentApiKey.id} />
        <label htmlFor={`limits-budget-${agentApiKey.id}`}>Budget USD limit</label>
        <input
          id={`limits-budget-${agentApiKey.id}`}
          name="budgetUsd"
          type="number"
          min="0.000001"
          step="0.000001"
          defaultValue={budgetLimit?.limitValue ?? defaultAgentLimitFormValues.budgetUsd}
          required
        />
        <label htmlFor={`limits-budget-period-${agentApiKey.id}`}>Budget period</label>
        <select
          id={`limits-budget-period-${agentApiKey.id}`}
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
        <label htmlFor={`limits-rpm-${agentApiKey.id}`}>RPM limit</label>
        <input
          id={`limits-rpm-${agentApiKey.id}`}
          name="rpm"
          type="number"
          min="1"
          step="1"
          defaultValue={rpmLimit?.limitValue ?? defaultAgentLimitFormValues.rpm}
          required
        />
        <label htmlFor={`limits-tpm-${agentApiKey.id}`}>TPM limit</label>
        <input
          id={`limits-tpm-${agentApiKey.id}`}
          name="tpm"
          type="number"
          min="1"
          step="1"
          defaultValue={tpmLimit?.limitValue ?? defaultAgentLimitFormValues.tpm}
          required
        />
        <label htmlFor={`limits-token-${agentApiKey.id}`}>Token limit</label>
        <input
          id={`limits-token-${agentApiKey.id}`}
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
        <button type="submit">Save rule</button>
      </form>
    </div>
  );
}

export async function PricingSection() {
  const databaseUrl = getConsoleDatabaseUrl();
  const pricePanel = await getPricePanel(databaseUrl);
  return (
    <section className="price-panel" aria-labelledby="price-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Prices</p>
          <h2 id="price-title">{previewModelId}</h2>
        </div>
        <p className="price-source">{pricePanel.sourceLabel}</p>
      </div>
      <dl className="price-grid">
        <div>
          <dt>Input</dt>
          <dd>{pricePanel.inputPriceLabel}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{pricePanel.outputPriceLabel}</dd>
        </div>
        <div>
          <dt>Estimate</dt>
          <dd>{pricePanel.estimateLabel}</dd>
        </div>
      </dl>
      <form className="price-form" action="/api/prices/override" method="post">
        <input type="hidden" name="providerKey" value={previewProviderKey} />
        <input type="hidden" name="modelId" value={previewModelId} />
        <label htmlFor="override-input-price">Override input price</label>
        <input
          id="override-input-price"
          name="inputUsdPerMillionTokens"
          type="number"
          min="0"
          step="0.00000001"
          defaultValue={pricePanel.inputPriceValue}
          required
        />
        <label htmlFor="override-output-price">Override output price</label>
        <input
          id="override-output-price"
          name="outputUsdPerMillionTokens"
          type="number"
          min="0"
          step="0.00000001"
          defaultValue={pricePanel.outputPriceValue}
          required
        />
        <button type="submit">Save price override</button>
      </form>
    </section>
  );
}

export async function ProvidersSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const modelRefreshProviderId = readSingleSearchParam(searchParams.modelRefreshProviderId);
  const providers = await listProviders(databaseUrl);
  const providerHealthSummaries = await listConsoleProviderHealthSummaries({ databaseUrl });
  const providerKeys = await listProviderApiKeyMetadata(databaseUrl);
  const providerModelOptions = await listProviderModelOptions(databaseUrl);
  const providerKeyByProviderId = new Map(
    providerKeys.map((providerKey) => [providerKey.providerId, providerKey]),
  );
  const providerHealthByProviderId = new Map(
    providerHealthSummaries.map((summary) => [summary.id, summary]),
  );
  const providerModelsByProviderId = groupProviderModelsByProviderId(providerModelOptions);
  const modelRefreshProvider = providers.find((provider) => provider.id === modelRefreshProviderId);
  const view = paginate(providers, readPageParam(searchParams));
  return (
    <section className="providers-panel" aria-label="Providers">
      <Disclosure tone="add" summary="New provider">
        <form className="provider-create-form" action="/api/providers" method="post">
          <input type="hidden" name="action" value="create" />
          <input type="hidden" name="providerType" value="api_key" />
          <label htmlFor="provider-key">Provider key</label>
          <input id="provider-key" name="providerKey" required />
          <label htmlFor="provider-display-name">Provider display name</label>
          <input id="provider-display-name" name="displayName" required />
          <label htmlFor="provider-base-url">Provider base URL</label>
          <input id="provider-base-url" name="baseUrl" type="url" />
          <button type="submit">Create provider</button>
        </form>
      </Disclosure>
      <Disclosure summary="Add from template">
        <div className="provider-template-selector">
          <fieldset className="provider-template-group">
            <legend>{remoteProviderTemplateGroup.label}</legend>
            <form className="provider-template-form" action="/api/providers" method="post">
              <input type="hidden" name="action" value="createFromTemplate" />
              <label htmlFor="provider-template">Provider template</label>
              <select id="provider-template" name="templateId" required>
                {remoteProviderTemplateGroup.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.displayName}
                  </option>
                ))}
              </select>
              <button type="submit">Add template provider</button>
            </form>
            <div className="provider-template-list">
              {remoteProviderTemplateGroup.templates.map((template) => (
                <ProviderTemplateSummary key={template.id} template={template} />
              ))}
            </div>
          </fieldset>
          <fieldset className="provider-template-group">
            <legend>{localProviderTemplateGroup.label}</legend>
            <div className="provider-template-list">
              {localProviderTemplateGroup.templates.map((template) => (
                <div className="provider-template-local-item" key={template.id}>
                  <ProviderTemplateSummary template={template} />
                  <form
                    className="provider-template-form local-provider-template-form"
                    action="/api/providers"
                    method="post"
                  >
                    <input type="hidden" name="action" value="createFromTemplate" />
                    <input type="hidden" name="templateId" value={template.id} />
                    <label htmlFor={`${template.id}-base-url`}>
                      {template.displayName} base URL
                    </label>
                    <input
                      id={`${template.id}-base-url`}
                      name="baseUrl"
                      type="url"
                      placeholder={template.baseUrlPlaceholder ?? "http://127.0.0.1:11434"}
                      required
                    />
                    <label className="checkbox-label" htmlFor={`${template.id}-public-risk`}>
                      <input
                        id={`${template.id}-public-risk`}
                        name="publicNetworkRiskAccepted"
                        type="checkbox"
                        value="true"
                      />
                      Accept public network risk
                    </label>
                    <button type="submit">Add local provider</button>
                  </form>
                </div>
              ))}
            </div>
          </fieldset>
        </div>
      </Disclosure>
      {modelRefreshProvider ? (
        <p role="status">Model refresh queued for {modelRefreshProvider.displayName}.</p>
      ) : null}
      {providers.length === 0 ? (
        <p>No providers configured.</p>
      ) : (
        <div className="row-list">
          {view.items.map((provider) => {
            const providerKeyMetadata = providerKeyByProviderId.get(provider.id);
            const providerHealth = providerHealthByProviderId.get(provider.id);
            const providerModels = providerModelsByProviderId.get(provider.id) ?? [];

            return (
              <Row
                key={provider.id}
                title={<h3 className="row-title">{provider.displayName}</h3>}
                meta={
                  <span className="row-meta">
                    <span className="mono">{provider.providerKey}</span>
                    <span>{providerModels.length} models</span>
                  </span>
                }
                status={
                  <span className={provider.enabled ? "status-enabled" : "status-disabled"}>
                    {provider.enabled ? "Enabled" : "Disabled"}
                  </span>
                }
              >
                <form className="provider-edit-form" action="/api/providers" method="post">
                  <input type="hidden" name="action" value="update" />
                  <input type="hidden" name="id" value={provider.id} />
                  <label htmlFor={`provider-display-${provider.id}`}>
                    Edit provider display name
                  </label>
                  <input
                    id={`provider-display-${provider.id}`}
                    name="displayName"
                    defaultValue={provider.displayName}
                    required
                  />
                  {provider.providerTemplateId ? (
                    <p>Template provider base URL: {provider.baseUrl}</p>
                  ) : (
                    <>
                      <label htmlFor={`provider-base-${provider.id}`}>Edit provider base URL</label>
                      <input
                        id={`provider-base-${provider.id}`}
                        name="baseUrl"
                        type="url"
                        defaultValue={provider.baseUrl ?? ""}
                      />
                    </>
                  )}
                  <button type="submit">Save provider</button>
                </form>
                <div className="provider-key-metadata">
                  {providerKeyMetadata ? (
                    <>
                      <p>Provider API key prefix: {providerKeyMetadata.keyPrefix}</p>
                      <p>
                        Provider API key created: {formatDateTime(providerKeyMetadata.createdAt)}
                      </p>
                      {providerKeyMetadata.rotatedAt ? (
                        <p>
                          Provider API key rotated: {formatDateTime(providerKeyMetadata.rotatedAt)}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p>No Provider API key saved.</p>
                  )}
                </div>
                <div className="provider-model-metadata">
                  {providerModels.length === 0 ? (
                    <p>No provider models discovered yet.</p>
                  ) : (
                    <p>
                      Provider models:{" "}
                      {providerModels
                        .map(
                          (model) =>
                            `${model.modelDisplayName} (${model.modelId}) - ${model.priceStatusLabel}`,
                        )
                        .join(", ")}
                    </p>
                  )}
                </div>
                <ProviderHealthSummaryPanel health={providerHealth} />
                <form className="provider-key-form" action="/api/provider-keys" method="post">
                  <input type="hidden" name="providerId" value={provider.id} />
                  <label htmlFor={`provider-api-key-${provider.id}`}>Provider API key</label>
                  <input
                    id={`provider-api-key-${provider.id}`}
                    name="providerApiKey"
                    type="password"
                    autoComplete="off"
                    required
                  />
                  <button type="submit">
                    {providerKeyMetadata ? "Rotate provider API key" : "Store provider API key"}
                  </button>
                </form>
                <div className="row-actions">
                  <form action="/api/providers" method="post">
                    <input type="hidden" name="id" value={provider.id} />
                    <input
                      type="hidden"
                      name="action"
                      value={provider.enabled ? "disable" : "enable"}
                    />
                    <button className="secondary-button" type="submit">
                      {provider.enabled ? "Disable provider" : "Enable provider"}
                    </button>
                  </form>
                  <form action="/api/provider-model-refresh" method="post">
                    <input type="hidden" name="providerId" value={provider.id} />
                    <button className="secondary-button" disabled={!provider.enabled} type="submit">
                      Refresh provider models
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

export async function SettingsSection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const databaseUrl = getConsoleDatabaseUrl();
  const configImportVersion = readSingleSearchParam(searchParams.configImportVersion);
  const notificationChannels = await listNotificationChannels(databaseUrl);
  return (
    <section className="providers-panel" id="settings" aria-label="Settings">
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
          <form className="provider-create-form" action="/api/notification-channels" method="post">
            <input type="hidden" name="action" value="create" />
            <input type="hidden" name="channelType" value="email" />
            <label htmlFor="notification-email-name">Email channel name</label>
            <input id="notification-email-name" name="displayName" required />
            <label htmlFor="notification-email-to">Email to</label>
            <input id="notification-email-to" name="emailTo" type="email" required />
            <label htmlFor="notification-email-from">Email from</label>
            <input id="notification-email-from" name="emailFrom" type="email" required />
            <button type="submit">Create email notification channel</button>
          </form>
          <form className="provider-create-form" action="/api/notification-channels" method="post">
            <input type="hidden" name="action" value="create" />
            <input type="hidden" name="channelType" value="webhook" />
            <label htmlFor="notification-webhook-name">Webhook channel name</label>
            <input id="notification-webhook-name" name="displayName" required />
            <label htmlFor="notification-webhook-url">Webhook URL</label>
            <input id="notification-webhook-url" name="webhookUrl" type="url" required />
            <button type="submit">Create webhook notification channel</button>
          </form>
        </div>
      </section>
      <div className="settings-grid">
        <section className="settings-panel" aria-labelledby="config-import-export-title">
          <h3 id="config-import-export-title">Config import/export</h3>
          {configImportVersion ? (
            <p className="status-enabled">Config import published version v{configImportVersion}</p>
          ) : null}
          <a className="secondary-button" download href="/api/config-export">
            Export redacted config
          </a>
          <form className="provider-create-form" action="/api/config-import" method="post">
            <label htmlFor="config-import-json">Config import JSON</label>
            <textarea id="config-import-json" name="configJson" required rows={8} />
            <button type="submit">Import redacted config</button>
          </form>
        </section>
      </div>
    </section>
  );
}

async function getPricePanel(databaseUrl: string) {
  const manualOverride = await getManualPriceOverride({
    databaseUrl,
    modelId: previewModelId,
    providerKey: previewProviderKey,
  });
  const price = resolveEffectiveModelTokenPrice({
    manualOverride,
    modelId: previewModelId,
    providerKey: previewProviderKey,
  });

  if (price.status === "unknown_price") {
    return {
      estimateLabel: "Sample estimate: unavailable",
      inputPriceLabel: "Unknown input price",
      inputPriceValue: "",
      outputPriceLabel: "Unknown output price",
      outputPriceValue: "",
      sourceLabel: "Unknown price",
    };
  }

  const estimate = calculateTokenCostUsd(price, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  const totalCost = estimate.status === "estimated" ? estimate.totalCostUsd : 0;

  return {
    estimateLabel: `Sample estimate: ${formatUsd(totalCost)}`,
    inputPriceLabel: `${formatUsd(price.inputUsdPerMillionTokens)} / 1M input`,
    inputPriceValue: String(price.inputUsdPerMillionTokens),
    outputPriceLabel: `${formatUsd(price.outputUsdPerMillionTokens)} / 1M output`,
    outputPriceValue: String(price.outputUsdPerMillionTokens),
    sourceLabel: price.source === "manual_override" ? "Manual override" : "Built-in price",
  };
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

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function getPlaygroundGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

function ProviderTemplateSummary({ template }: { template: ProviderTemplateSelectorItem }) {
  return (
    <article className="provider-template-card">
      <h3>{template.displayName}</h3>
      {template.fixedBaseUrl ? <p>Fixed base URL: {template.fixedBaseUrl}</p> : null}
      {template.baseUrlMode === "user_local_private" ? (
        <p>Base URL: user-provided local/private URL</p>
      ) : null}
      {template.modelListPath ? <p>Model list path: {template.modelListPath}</p> : null}
      {template.chatPath ? <p>Chat path: {template.chatPath}</p> : null}
      {template.auth ? <p>Auth: {formatProviderTemplateAuth(template)}</p> : null}
      <p>Capabilities: {formatProviderTemplateCapabilities(template)}</p>
    </article>
  );
}

function formatProviderTemplateCapabilities(template: ProviderTemplateSelectorItem): string {
  return template.capabilities.map(formatProviderTemplateCapability).join(", ");
}

function formatProviderTemplateCapability(capability: string): string {
  if (capability === "chat_completions") {
    return "Chat completions";
  }

  return capability.charAt(0).toUpperCase() + capability.slice(1);
}

function formatProviderTemplateAuth(template: ProviderTemplateSelectorItem): string {
  if (!template.auth) {
    return "None";
  }

  return `${template.auth.header} ${template.auth.scheme} API key`;
}

function requireProviderTemplateGroup(id: "remote_api_key" | "local") {
  const group = providerTemplateGroups.find((candidate) => candidate.id === id);
  if (!group) {
    throw new Error(`Provider template group ${id} is missing.`);
  }
  return group;
}

function ProviderHealthSummaryPanel({
  health,
}: {
  health: ConsoleProviderHealthSummary | undefined;
}) {
  const providerHealth = health ?? {
    consecutiveFailures: 0,
    latestProbeAt: null,
    models: [],
    status: "unknown" as const,
    trigger: null,
  };

  return (
    <div className="provider-health-summary">
      <p>Provider health: {formatProviderHealthStatus(providerHealth.status)}</p>
      <p>
        {formatProviderHealthLatestProbe({
          latestProbeAt: providerHealth.latestProbeAt,
          trigger: providerHealth.trigger,
        })}
      </p>
      <p>{formatProviderHealthFailureCount(providerHealth.consecutiveFailures)}</p>
      <p>
        Provider health stale status:{" "}
        {formatProviderHealthStaleStatus({ latestProbeAt: providerHealth.latestProbeAt })}
      </p>
      {providerHealth.models.length === 0 ? (
        <p>No provider model health recorded.</p>
      ) : (
        <div className="provider-model-health-list">
          {providerHealth.models.map((model) => (
            <div className="provider-model-health-item" key={model.id}>
              <p>Model: {model.displayName}</p>
              <p>Model health: {formatProviderHealthStatus(model.status)}</p>
              <p>
                {formatProviderHealthLatestProbe({
                  latestProbeAt: model.latestProbeAt,
                  trigger: model.trigger,
                })}
              </p>
              <p>{formatProviderHealthFailureCount(model.consecutiveFailures)}</p>
              <p>
                Model health stale status:{" "}
                {formatProviderHealthStaleStatus({ latestProbeAt: model.latestProbeAt })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDateTime(value: Date): string {
  return value.toISOString();
}

function formatNullableDateTime(value: Date | null): string {
  return value ? formatDateTime(value) : "Unknown";
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

function virtualModelSelectSize(optionCount: number): number {
  return Math.min(6, Math.max(2, optionCount));
}

function formatVirtualModelOptionLabel(virtualModel: {
  displayName: string;
  name: string;
}): string {
  return `${virtualModel.displayName} (${virtualModel.name})`;
}

function findAgentLimit(
  limits: readonly ConsoleAgentLimit[],
  limitType: ConsoleAgentLimit["limitType"],
): ConsoleAgentLimit | undefined {
  return limits.find((limit) => limit.limitType === limitType);
}

function groupByAgentApiKeyId<T extends { agentApiKeyId: string }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = grouped.get(value.agentApiKeyId) ?? [];
    group.push(value);
    grouped.set(value.agentApiKeyId, group);
  }
  return grouped;
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
