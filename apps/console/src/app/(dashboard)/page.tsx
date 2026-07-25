import { listConsoleActivities } from "@llmingress/db/console-activity";
import { listSavedApiKeyLimits } from "@llmingress/db/console-api-key-limits";
import { listApiKeys } from "@llmingress/db/console-api-keys";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import { listProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import { listConsoleProviderOAuthConnections } from "@llmingress/db/console-provider-oauth";
import { listConsoleProviderQuotaSummaries } from "@llmingress/db/console-provider-quota";
import { listProviders } from "@llmingress/db/console-providers";
import {
  type ConsoleUsageWindow,
  getConsolePreviousWindowKpis,
  getConsoleUsageSummary,
} from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import Link from "next/link";
import { ChartLegend, StackedBarChart } from "../_ui/charts";
import { ActionLink, Meter, StatusDot } from "../_ui/controls";
import {
  formatClock,
  formatCompact,
  formatCost,
  formatCount,
  formatDelta,
  formatLatency,
  formatPercent,
  formatRelative,
} from "../_ui/format";
import { EmptyState, PageShell, SectionTitle } from "../_ui/layout";
import { AutoRefresh } from "../_ui/overview/auto-refresh";
import { GettingStarted } from "../_ui/overview/getting-started";
import { readParam, type SearchParams } from "../_ui/params";
import { buildProviderConnections, describeConnectionHealth } from "../_ui/providers/model";
import { PlanQuotaPanel } from "../_ui/quota-panel";
import { GridRow } from "../_ui/table";
import { axisLabelsForWindow, readUsageWindow, WindowPicker } from "../_ui/usage/window";

const BREAKDOWN_COLUMNS = "120px 1fr 58px 62px 58px";
const KEY_COLUMNS = "120px 1fr 58px 62px 58px 44px";
const FAILURE_COLUMNS = "54px 1fr 118px";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();
  const window: ConsoleUsageWindow = readUsageWindow(readParam(params, "window"));

  const [
    usage,
    previous,
    providers,
    virtualModels,
    apiKeys,
    limits,
    health,
    quotas,
    providerApiKeys,
    oauth,
    recentFailures,
  ] = await Promise.all([
    getConsoleUsageSummary({ now, window }),
    getConsolePreviousWindowKpis({ now, window }),
    listProviders(),
    listVirtualModels(),
    listApiKeys(),
    listSavedApiKeyLimits(),
    listConsoleProviderHealthSummaries(),
    listConsoleProviderQuotaSummaries(),
    listProviderApiKeyMetadata(),
    listConsoleProviderOAuthConnections(),
    listConsoleActivities({ filters: { status: "failed" }, limit: 5 }),
  ]);

  const connections = providers.flatMap((provider) =>
    buildProviderConnections({ apiKeys: providerApiKeys, health, oauth, provider }).map(
      (connection) => ({ connection, provider }),
    ),
  );
  const keyedLimits = new Set(limits.map((limit) => limit.apiKeyId));
  const requestDelta = formatDelta(usage.requestCount, previous.requestCount);

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

  const unhealthy = connections.filter(
    ({ connection }) => describeConnectionHealth(connection).tone === "red",
  );
  const healthyCount = connections.length - unhealthy.length;

  return (
    <PageShell label="Overview">
      <div className="flex items-baseline gap-4 pt-[22px]">
        <h1 className="font-sans text-25 font-semibold tracking-[-.02em] text-ink">Overview</h1>
        <WindowPicker params={params} pathname="/" window={window} />
        <AutoRefresh />
      </div>

      <GettingStarted
        counts={{
          apiKeyCount: apiKeys.length,
          connectionCount: connections.length,
          providerCount: providers.length,
          unlimitedKeyCount: apiKeys.filter((key) => !keyedLimits.has(key.id)).length,
          virtualModelCount: virtualModels.length,
        }}
        params={params}
      />

      {usage.requestCount === 0 ? (
        <EmptyState
          title="No traffic yet"
          body="Usage, health and cost panels fill in as soon as the gateway serves its first request. Follow the four steps above — the checklist tracks them for you."
        />
      ) : (
        <>
          <div className="mt-[18px] grid grid-cols-5 border-y border-hair border-b-rule">
            <Kpi label="REQUESTS" value={formatCount(usage.requestCount)}>
              {requestDelta ? (
                <span className={requestDelta.up ? "text-green" : "text-redtx"}>
                  {requestDelta.text}
                </span>
              ) : (
                <span>no prior window to compare</span>
              )}
            </Kpi>
            <Kpi label="TOKENS" value={formatCompact(usage.totalTokens)}>
              {formatCompact(usage.inputTokens)} in / {formatCompact(usage.outputTokens)} out
            </Kpi>
            <Kpi label="COST" value={formatCost(usage.totalCostUsd)}>
              {formatCost((Number.parseFloat(usage.totalCostUsd ?? "0") || 0) / usage.requestCount)}{" "}
              / req
            </Kpi>
            <Kpi
              label="FAILURE RATE"
              tone="text-red"
              value={formatPercent(usage.failureCount / usage.requestCount, 2)}
            >
              {formatCount(usage.failureCount)} failed
            </Kpi>
            <Kpi label="AVG LATENCY" value={formatLatency(usage.avgLatencyMs)}>
              first byte, mean
            </Kpi>
          </div>

          <div className="grid grid-cols-[1fr_400px]">
            <div className="border-r border-rule py-5 pr-6">
              <div className="flex items-baseline">
                <span className="font-sans text-155 font-semibold text-ink">
                  Requests, {window === "24h" ? "hourly" : "daily"}
                </span>
                <ChartLegend series={requestSeries} />
              </div>
              <StackedBarChart
                axisLabels={axisLabelsForWindow(window, usage.trend, now)}
                height={168}
                series={requestSeries}
              />

              <div className="mt-6 grid grid-cols-2 gap-x-6">
                <Breakdown
                  columns={BREAKDOWN_COLUMNS}
                  rows={usage.providerBreakdowns}
                  title="Usage by provider"
                  unit="PROVIDER"
                />
                <Breakdown
                  columns={KEY_COLUMNS}
                  rows={usage.apiKeyBreakdowns}
                  showFails
                  title="Usage by API key"
                  unit="API KEY"
                />
              </div>
            </div>

            <div className="py-5 pl-6">
              <SectionTitle>Connection health</SectionTitle>
              <div className="mt-2 border-t border-hair">
                {connections.length === 0 ? (
                  <p className="py-3 font-mono text-13 text-dim">
                    No connection yet — no provider can serve traffic.
                  </p>
                ) : (
                  <>
                    {unhealthy.map(({ connection, provider }) => {
                      const view = describeConnectionHealth(connection);
                      return (
                        <div
                          key={connection.id}
                          className="flex items-center gap-[9px] border-b border-rule2 py-2"
                        >
                          <StatusDot tone="red" />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-135 text-ink cell-clip">
                              {provider.displayName} · {connection.label}
                            </div>
                            <div className="mt-px font-mono text-125 text-redtx cell-clip">
                              {view.text}
                            </div>
                          </div>
                          <form action="/api/provider-health-probes" method="post">
                            <input type="hidden" name="providerId" value={provider.id} />
                            <input
                              type="hidden"
                              name="providerConnectionId"
                              value={connection.id}
                            />
                            <button
                              type="submit"
                              className="whitespace-nowrap rounded-xs border border-btnbd bg-btnbg px-2 py-[2px] font-mono text-125 font-medium text-ink"
                            >
                              Re-check
                            </button>
                          </form>
                        </div>
                      );
                    })}
                    {healthyCount > 0 ? (
                      <div className="flex items-center gap-[9px] border-b border-rule2 py-2">
                        <StatusDot tone="green" />
                        <span className="flex-1 font-mono text-135 text-dim">
                          {formatCount(healthyCount)} healthy connections
                        </span>
                        <Link href="/providers" className="font-mono text-125 text-faint">
                          → Providers
                        </Link>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <PlanQuotaPanel now={now} summaries={quotas} />

              <SectionTitle
                className="mt-5"
                trailing={
                  <Link href="/activity" className="font-mono text-13 text-dim">
                    → Activity
                  </Link>
                }
              >
                Recent failures
              </SectionTitle>
              <div className="mt-2 border-t border-hair">
                {recentFailures.length === 0 ? (
                  <p className="py-3 font-mono text-13 text-dim">
                    No failed request in the retention window.
                  </p>
                ) : (
                  recentFailures.map((activity) => (
                    <GridRow key={activity.id} columns={FAILURE_COLUMNS} gap={10}>
                      <span className="text-faint tabnum">{formatClock(activity.startedAt)}</span>
                      <span className="cell-clip">
                        {activity.apiKeyName ?? "unknown key"} →{" "}
                        {activity.virtualModelName ?? "unknown model"}
                      </span>
                      <span className="text-right text-redtx cell-clip">
                        {activity.httpStatus ?? "—"} {activity.errorCode ?? "failed"}
                      </span>
                    </GridRow>
                  ))
                )}
              </div>
              <p className="mt-2 font-mono text-12 leading-[1.6] text-faint">
                Newest first, from the last{" "}
                {formatRelative(usage.trend[0]?.bucketStart ?? now, now)}
                {" of recorded activity."}
              </p>
            </div>
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
    <div className="px-[18px] pb-4 pt-[14px] first:pl-0 last:pr-0">
      <div className="font-mono text-12 font-medium tracking-[.12em] text-dim">{label}</div>
      <div className={`mt-[6px] font-mono text-31 font-medium tracking-[-.03em] ${tone} tabnum`}>
        {value}
      </div>
      <div className="mt-[3px] font-mono text-13 text-dim">{children}</div>
    </div>
  );
}

function Breakdown({
  columns,
  rows,
  showFails = false,
  title,
  unit,
}: {
  columns: string;
  rows: Array<{
    failureCount: number;
    id: string;
    label: string;
    requestCount: number;
    totalCostUsd: string | null;
    totalTokens: number;
  }>;
  showFails?: boolean;
  title: string;
  unit: string;
}) {
  const total = rows.reduce((sum, row) => sum + row.requestCount, 0);
  return (
    <div>
      <SectionTitle
        trailing={
          <Link href="/usage" className="font-mono text-13 text-dim">
            → Usage
          </Link>
        }
      >
        {title}
      </SectionTitle>
      <div className="mt-2">
        <GridRow columns={columns} gap={8} head>
          <span>{unit}</span>
          <span>SHARE</span>
          <span className="text-right">REQS</span>
          <span className="text-right">TOKENS</span>
          <span className="text-right">COST</span>
          {showFails ? <span className="text-right">FAILS</span> : null}
        </GridRow>
        {rows.map((row) => (
          <GridRow key={row.id} columns={columns} gap={8}>
            <span className="font-medium cell-clip">{row.label}</span>
            <Meter height={8} ratio={total > 0 ? row.requestCount / total : 0} />
            <span className="text-right tabnum">{formatCount(row.requestCount)}</span>
            <span className="text-right tabnum">{formatCompact(row.totalTokens)}</span>
            <span className="text-right tabnum">{formatCost(row.totalCostUsd)}</span>
            {showFails ? (
              <span className="text-right tabnum">{formatCount(row.failureCount)}</span>
            ) : null}
          </GridRow>
        ))}
      </div>
    </div>
  );
}
