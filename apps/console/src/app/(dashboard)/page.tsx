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
  getUsageWindowStart,
} from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import Link from "next/link";
import { ChartLegend, StackedBarChart } from "../_ui/charts";
import { Meter, StatusDot } from "../_ui/controls";
import { activityHref, activityWindowForUsageWindow } from "../_ui/cross-links";
import {
  failureRateTone,
  failureRateToneClass,
  formatClock,
  formatCompact,
  formatCost,
  formatCount,
  formatDelta,
  formatLatency,
  formatPercent,
} from "../_ui/format";
import { EmptyState, PageShell, SectionTitle } from "../_ui/layout";
import { MutationForm } from "../_ui/mutation-form";
import { AutoRefresh } from "../_ui/overview/auto-refresh";
import { GettingStarted } from "../_ui/overview/getting-started";
import { readParam, type SearchParams } from "../_ui/params";
import { buildProviderConnections, describeConnectionHealth } from "../_ui/providers/model";
import { PlanQuotaPanel } from "../_ui/quota-panel";
import { GridRow } from "../_ui/table";
import { axisLabelsForWindow, readUsageWindow } from "../_ui/usage/axis";
import { WindowPicker } from "../_ui/usage/window";

const BREAKDOWN_COLUMNS = "120px 1fr 58px 62px 58px";
const KEY_COLUMNS = "120px 1fr 58px 62px 58px 44px";
const FAILURE_COLUMNS = "54px 1fr 118px";

/**
 * Every list on this page is capped. The Overview is read at a glance and its
 * height is part of that: a console with forty connections or eighty keys would
 * otherwise push the panel below it off the screen entirely. Each capped list
 * says how many it is not showing and links to the page that shows them all.
 */
const CONNECTION_HEALTH_ROWS = 4;
const PLAN_QUOTA_ROWS = 2;
const BREAKDOWN_ROWS = 8;
const FAILURE_ROWS = 5;

/**
 * The three panels in the middle band are one row of the page, so they end
 * where each other ends: a quota panel that ran two rows taller than the two
 * beside it pushed the usage tables below the fold on its own. The caps keep
 * the content inside this, and anything unusual (a plan reporting several
 * windows) scrolls in place rather than growing the band.
 */
const BAND_BODY_HEIGHT = "h-[178px] overflow-y-auto";

/** Worst first — the panel exists for what is not serving. */
const HEALTH_TONE_ORDER = { red: 0, amber: 1, dim: 2, green: 3 } as const;

const healthRank = (tone: keyof typeof HEALTH_TONE_ORDER) => HEALTH_TONE_ORDER[tone];

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
    // The same window every other number on this page is measured over: a
    // failure from outside it is not part of what the page is describing.
    listConsoleActivities({
      filters: { from: getUsageWindowStart(now, window), status: "failed" },
      limit: FAILURE_ROWS,
    }),
  ]);

  const connections = providers.flatMap((provider) =>
    buildProviderConnections({ apiKeys: providerApiKeys, health, oauth, provider }).map(
      (connection) => ({ connection, provider }),
    ),
  );
  const keyedLimits = new Set(limits.map((limit) => limit.apiKeyId));
  const requestDelta = formatDelta(usage.requestCount, previous.requestCount, "up-good");

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

  const connectionViews = connections.map(({ connection, provider }) => ({
    connection,
    provider,
    view: describeConnectionHealth(connection),
  }));
  // "healthy" has to mean healthy: a connection still being checked, or one
  // that is switched off, is neither failing nor serving, and folding it into
  // this count would overstate what is actually carrying traffic.
  const healthyCount = connectionViews.filter(({ view }) => view.tone === "green").length;
  const unhealthyCount = connectionViews.filter(({ view }) => view.tone === "red").length;
  // Deliberately off and still being checked are different answers to "is it
  // serving": one is a decision, the other is a wait, and rolling them together
  // makes a console someone disabled look like one that is still starting up.
  const disabledCount = connectionViews.filter(({ connection }) => !connection.enabled).length;
  const checkingCount = connectionViews.length - unhealthyCount - healthyCount - disabledCount;
  // Worst first: this panel exists to surface what is not serving, and a long
  // list of working connections would push it off the fold.
  const orderedConnections = [...connectionViews].sort(
    (left, right) => healthRank(left.view.tone) - healthRank(right.view.tone),
  );
  const shownConnections = orderedConnections.slice(0, CONNECTION_HEALTH_ROWS);
  const hiddenConnections = orderedConnections.slice(CONNECTION_HEALTH_ROWS);
  const hiddenHealthyCount = hiddenConnections.filter(({ view }) => view.tone === "green").length;

  return (
    <PageShell label="Overview">
      <div className="flex items-baseline gap-4 overflow-x-auto pt-[22px]">
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
          <div className="mt-[18px] overflow-x-auto border-y border-hair border-b-rule">
            <div className="grid min-w-[900px] grid-cols-5">
              <Kpi label="REQUESTS" value={formatCount(usage.requestCount)}>
                {requestDelta ? (
                  <span
                    className={
                      requestDelta.tone === "good"
                        ? "text-green"
                        : requestDelta.tone === "bad"
                          ? "text-redtx"
                          : "text-dim"
                    }
                  >
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
                {/* A request that failed on one candidate and was served by
                    the next is not in the failure count, and it is the thing an
                    operator most wants to see next to it. */}
                {formatCount(usage.failureCount)} failed ·{" "}
                {formatCount(usage.fallbackRecoveredCount)} fallback
              </Kpi>
              <Kpi label="AVG LATENCY" value={formatLatency(usage.avgLatencyMs)}>
                first byte, mean
              </Kpi>
            </div>
          </div>

          {/* The chart is the widest object on the page and takes the whole
              width; the panels below are read as two bands across it. */}
          <div className="py-5">
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
          </div>

          <div className="grid grid-cols-3 items-start gap-x-8 overflow-x-auto border-t border-hair py-5">
            {/* Each capped panel is addressable: what it draws and what it says
                it is leaving out is a contract, and the names repeat elsewhere
                on the page. */}
            <div data-testid="overview-connection-health">
              <SectionTitle
                trailing={
                  <Link href="/providers" className="font-mono text-13 text-dim">
                    → Providers
                  </Link>
                }
              >
                Connection health
              </SectionTitle>
              <div className={`mt-2 border-t border-hair ${BAND_BODY_HEIGHT}`}>
                {connections.length === 0 ? (
                  <p className="py-3 font-mono text-13 text-dim">
                    No connection yet — no provider can serve traffic.
                  </p>
                ) : (
                  <>
                    {shownConnections.map(({ connection, provider, view }) => (
                      <div
                        key={connection.id}
                        className="flex items-center gap-[9px] border-b border-rule2 py-2"
                      >
                        <StatusDot tone={view.tone} />
                        <div className="min-w-0 flex-1">
                          <div
                            className={`font-mono text-135 cell-clip ${
                              view.tone === "green" ? "text-dim" : "text-ink"
                            }`}
                          >
                            {provider.displayName} · {connection.label}
                          </div>
                          {view.tone === "red" ? (
                            <div className="mt-px font-mono text-125 text-redtx cell-clip">
                              {view.text}
                            </div>
                          ) : null}
                        </div>
                        {view.tone === "red" ? (
                          <MutationForm
                            action="/api/provider-health-probes"
                            fallbackError="The re-check could not be queued."
                          >
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
                          </MutationForm>
                        ) : (
                          <span className="flex-none font-mono text-125 text-faint tabnum">
                            {view.tone === "green"
                              ? connection.health?.latestProbeAt
                                ? formatClock(connection.health.latestProbeAt)
                                : "healthy"
                              : view.text}
                          </span>
                        )}
                      </div>
                    ))}
                    {hiddenConnections.length > 0 ? (
                      <div className="flex items-center gap-[9px] border-b border-rule2 py-2">
                        <StatusDot
                          tone={hiddenHealthyCount === hiddenConnections.length ? "green" : "dim"}
                        />
                        <span className="flex-1 font-mono text-135 text-dim">
                          {hiddenHealthyCount === hiddenConnections.length
                            ? `${formatCount(hiddenHealthyCount)} more healthy connections`
                            : `${formatCount(hiddenConnections.length)} more connections`}
                        </span>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              {connections.length > 0 ? (
                <p className="mt-2 font-mono text-12 leading-[1.6] text-faint">
                  {formatCount(healthyCount)} serving
                  {unhealthyCount > 0 ? ` · ${formatCount(unhealthyCount)} failing` : ""}
                  {checkingCount > 0 ? ` · ${formatCount(checkingCount)} still checking` : ""}
                  {disabledCount > 0 ? ` · ${formatCount(disabledCount)} disabled` : ""}
                </p>
              ) : null}
            </div>

            <PlanQuotaPanel
              bodyClassName={BAND_BODY_HEIGHT}
              limit={PLAN_QUOTA_ROWS}
              testId="overview-plan-quota"
              moreHref="/providers"
              now={now}
              summaries={quotas}
              titleClassName=""
              trailing={
                <Link href="/providers" className="font-mono text-13 text-dim">
                  → Providers
                </Link>
              }
            />

            <div data-testid="overview-recent-failures">
              <SectionTitle
                trailing={
                  <Link
                    href={activityHref({
                      status: "failed",
                      window: activityWindowForUsageWindow(window),
                    })}
                    className="font-mono text-13 text-dim"
                  >
                    → Activity
                  </Link>
                }
              >
                Recent failures
              </SectionTitle>
              <div className={`mt-2 border-t border-hair ${BAND_BODY_HEIGHT}`}>
                {recentFailures.length === 0 ? (
                  <p className="py-3 font-mono text-13 text-dim">
                    No failed request in this window.
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
                The {FAILURE_ROWS} newest failures in the selected window — → Activity for the rest.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 items-start gap-x-8 overflow-x-auto border-t border-hair py-5">
            <Breakdown
              columns={BREAKDOWN_COLUMNS}
              limit={BREAKDOWN_ROWS}
              rows={usage.providerBreakdowns}
              testId="overview-usage-providers"
              title="Usage by provider"
              unit="PROVIDER"
            />
            <Breakdown
              columns={KEY_COLUMNS}
              limit={BREAKDOWN_ROWS}
              rows={usage.apiKeyBreakdowns}
              showFails
              testId="overview-usage-api-keys"
              title="Usage by API key"
              unit="API KEY"
            />
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
  limit,
  rows,
  showFails = false,
  testId,
  title,
  unit,
}: {
  columns: string;
  /** Rows to draw; the rest are counted and left to the Usage page. */
  limit: number;
  rows: Array<{
    failureCount: number;
    id: string;
    label: string;
    requestCount: number;
    totalCostUsd: string | null;
    totalTokens: number;
  }>;
  showFails?: boolean;
  testId: string;
  title: string;
  unit: string;
}) {
  // The share is a share of everything, not of what fits on screen.
  const total = rows.reduce((sum, row) => sum + row.requestCount, 0);
  const shown = rows.slice(0, limit);
  const hiddenCount = rows.length - shown.length;
  return (
    <div data-testid={testId}>
      <SectionTitle
        trailing={
          <Link href="/usage" className="font-mono text-13 text-dim">
            → Usage
          </Link>
        }
      >
        {title}
      </SectionTitle>
      <div className="mt-2 overflow-x-auto">
        <GridRow columns={columns} gap={8} head>
          <span>{unit}</span>
          <span>SHARE</span>
          <span className="text-right">REQS</span>
          <span className="text-right">TOKENS</span>
          <span className="text-right">COST</span>
          {showFails ? <span className="text-right">FAILS</span> : null}
        </GridRow>
        {shown.map((row) => (
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
      {hiddenCount > 0 ? (
        <p className="mt-2 font-mono text-12 text-faint">
          {formatCount(hiddenCount)} more in Usage — the busiest {formatCount(shown.length)} are
          here.
        </p>
      ) : null}
    </div>
  );
}
