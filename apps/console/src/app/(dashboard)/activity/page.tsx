import {
  countConsoleActivities,
  getConsoleActivityDetail,
  listConsoleActivities,
} from "@llmingress/db/console-activity";
import { listApiKeys } from "@llmingress/db/console-api-keys";
import { listProviders } from "@llmingress/db/console-providers";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import { ActivityDrawer } from "../../_ui/activity/drawer";
import { ACTIVITY_WINDOWS, activityStatusTone, readActivityWindow } from "../../_ui/activity/model";
import { ActionLink, FilterButton, filterControlClass } from "../../_ui/controls";
import { formatClockSeconds, formatCost, formatCount, formatLatency } from "../../_ui/format";
import { EmptyState, PageShell, PageTitleRow } from "../../_ui/layout";
import {
  buildHref,
  readIntParam,
  readParam,
  type SearchParams,
  urlFormStateKey,
} from "../../_ui/params";
import { formatRange, GridRow, Pagination } from "../../_ui/table";

const COLUMNS = "80px 134px 124px 134px 286px 136px 66px 66px 62px 74px 84px";
const PAGE_SIZE = 20;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();

  const windowKey = readActivityWindow(readParam(params, "window"));
  const filters = {
    apiKeyId: readParam(params, "apiKey"),
    from: new Date(now.getTime() - ACTIVITY_WINDOWS[windowKey].ms),
    protocol: readParam(params, "protocol"),
    providerId: readParam(params, "provider"),
    requestIdQuery: readParam(params, "q"),
    status: readParam(params, "status"),
    to: now,
    virtualModelId: readParam(params, "virtualModel"),
  };
  const page = readIntParam(params, "page", 1);
  // The window is a filter too: "Clear" goes back to the default view, so it
  // offers itself whenever this view is not that one.
  const hasFilters = [
    "apiKey",
    "protocol",
    "provider",
    "q",
    "status",
    "virtualModel",
    "window",
  ].some((key) => readParam(params, key) !== undefined);

  const [rows, total, recordedTotal, apiKeys, virtualModels, providers] = await Promise.all([
    listConsoleActivities({ filters, limit: PAGE_SIZE, page }),
    countConsoleActivities({ filters }),
    // Unfiltered, so an empty view can tell "nothing recorded yet" apart from
    // "nothing in this window" — the default window is itself a filter.
    countConsoleActivities({}),
    listApiKeys(),
    listVirtualModels(),
    listProviders(),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedRequestId = readParam(params, "request");
  const detail = selectedRequestId
    ? await getConsoleActivityDetail({ requestId: selectedRequestId })
    : null;

  const consoleHasNeverServed = recordedTotal === 0;
  const activityFilterFormKey = urlFormStateKey(
    filters.status,
    filters.protocol,
    filters.apiKeyId,
    filters.virtualModelId,
    filters.providerId,
    windowKey,
    filters.requestIdQuery,
  );

  return (
    <PageShell label="Activity">
      <PageTitleRow
        title="Activity"
        meta="request metadata by default — bodies are stored only for keys whose request logging mode is full, never credentials"
      />

      <form
        key={activityFilterFormKey}
        method="get"
        action="/activity"
        className="mt-[14px] grid grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.25fr)_repeat(2,minmax(0,1fr))_minmax(0,1.2fr)_auto_auto] items-center gap-2 overflow-x-auto"
      >
        <select
          name="status"
          defaultValue={filters.status ?? ""}
          aria-label="Filter by status"
          className={filterControlClass}
        >
          <option value="">Status: all</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="canceled">canceled</option>
          <option value="started">started</option>
        </select>
        <select
          name="protocol"
          defaultValue={filters.protocol ?? ""}
          aria-label="Filter by protocol"
          className={filterControlClass}
        >
          <option value="">Protocol: all</option>
          <option value="chat_completions">chat_completions</option>
          <option value="messages">messages</option>
          <option value="responses">responses</option>
        </select>
        <select
          name="apiKey"
          defaultValue={filters.apiKeyId ?? ""}
          aria-label="Filter by API key"
          className={filterControlClass}
        >
          <option value="">API key: all</option>
          {apiKeys.map((apiKey) => (
            <option key={apiKey.id} value={apiKey.id}>
              {apiKey.name}
            </option>
          ))}
        </select>
        <select
          name="virtualModel"
          defaultValue={filters.virtualModelId ?? ""}
          aria-label="Filter by virtual model"
          className={filterControlClass}
        >
          <option value="">Virtual model: all</option>
          {virtualModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <select
          name="provider"
          defaultValue={filters.providerId ?? ""}
          aria-label="Filter by provider"
          className={filterControlClass}
        >
          <option value="">Provider: all</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}
            </option>
          ))}
        </select>
        <select
          name="window"
          defaultValue={windowKey}
          aria-label="Filter by time window"
          className={filterControlClass}
        >
          {Object.entries(ACTIVITY_WINDOWS).map(([key, entry]) => (
            <option key={key} value={key}>
              {entry.label}
            </option>
          ))}
        </select>
        <input
          name="q"
          defaultValue={filters.requestIdQuery ?? ""}
          placeholder="search request id…"
          aria-label="Search by request id"
          className={`${filterControlClass} box-border h-[30px]`}
        />
        <FilterButton>Apply</FilterButton>
        {/* Six filters and a search box: the way back to everything is a
            control, not a memory of which ones were touched. */}
        {hasFilters ? (
          <ActionLink href="/activity" size="row">
            Clear
          </ActionLink>
        ) : null}
        <span className="whitespace-nowrap font-mono text-13 text-faint">
          {formatCount(total)} matching
        </span>
      </form>

      <div className="mt-3 overflow-x-auto">
        <GridRow columns={COLUMNS} gap={10} head className="border-t border-hair text-12">
          <span>TIME</span>
          <span>REQUEST</span>
          <span>API KEY</span>
          <span>VIRTUAL MODEL</span>
          <span>ROUTED TO</span>
          <span>PROTOCOL</span>
          <span className="text-right">IN</span>
          <span className="text-right">OUT</span>
          <span className="text-right">LAT</span>
          <span className="text-right">COST</span>
          <span className="text-right">STATUS</span>
        </GridRow>

        {rows.length === 0 ? (
          !consoleHasNeverServed ? (
            <div className="border-b border-rule2 py-9 text-center">
              <div className="font-sans text-15 font-semibold text-ink">
                No requests match these filters
              </div>
              <p className="mx-auto mt-[6px] max-w-[520px] font-mono text-13 leading-[1.6] text-dim">
                Activity keeps request metadata for the retention window only — a narrow time range
                or an unused key combination can legitimately return nothing.
              </p>
              <ActionLink className="mt-3" href="/activity">
                Clear filters
              </ActionLink>
            </div>
          ) : (
            <EmptyState
              title="No requests yet"
              body="Activity records request metadata as soon as an agent calls the gateway — bodies only for keys whose request logging mode is full. Send one from the Playground to confirm your routing works end to end."
              actions={
                <ActionLink href="/playground" tone="primary">
                  Open Playground
                </ActionLink>
              }
            />
          )
        ) : (
          rows.map((activity) => {
            const tone = activityStatusTone(activity.status);
            return (
              <GridRow
                key={activity.id}
                columns={COLUMNS}
                gap={10}
                href={buildHref("/activity", params, { request: activity.requestId })}
                selected={activity.requestId === selectedRequestId}
              >
                <span className="text-faint tabnum">{formatClockSeconds(activity.startedAt)}</span>
                <span className="text-dim cell-clip">{activity.requestId}</span>
                <span className="cell-clip">{activity.apiKeyName ?? "—"}</span>
                <span className="cell-clip">{activity.virtualModelName ?? "—"}</span>
                <span className="cell-clip">
                  {activity.fallbackFailedAttemptCount > 0 ? "↯ " : ""}
                  {activity.providerDisplayName ?? "no candidate"}
                  {activity.providerModelName ? ` · ${activity.providerModelName}` : ""}
                </span>
                <span className="text-dim cell-clip">{activity.protocol}</span>
                {/* One request's token counts are exact: abbreviating an
                    individual value loses the precision the row exists for. */}
                <span className="text-right tabnum">
                  {activity.inputTokens === null ? "—" : formatCount(activity.inputTokens)}
                </span>
                <span className="text-right tabnum">
                  {activity.outputTokens === null ? "—" : formatCount(activity.outputTokens)}
                </span>
                <span className="text-right tabnum">{formatLatency(activity.latencyMs)}</span>
                <span className="text-right tabnum">{formatCost(activity.totalCostUsd)}</span>
                <span className={`text-right font-medium ${tone}`}>
                  {activity.httpStatus ?? activity.status}
                </span>
              </GridRow>
            );
          })
        )}
      </div>

      {rows.length > 0 ? (
        <Pagination
          buildHref={(next) => buildHref("/activity", params, { page: String(next) })}
          page={page}
          pageCount={pageCount}
          rangeLabel={formatRange({ page, pageSize: PAGE_SIZE, total })}
        />
      ) : null}

      {detail ? <ActivityDrawer detail={detail} params={params} /> : null}
    </PageShell>
  );
}
