import {
  type ConsoleActivity,
  type ConsoleActivityDetail,
  type ConsoleActivityFiltersInput,
  type ConsoleFallbackEvent,
  countConsoleActivities,
  formatConsoleActivityMetadata,
  formatConsoleActivityRouteReason,
  getConsoleActivityDetail,
  listConsoleActivities,
} from "@llmingress/db/console-activity";
import { listAgents } from "@llmingress/db/console-agents";
import {
  formatConsoleCount,
  formatConsoleTimestamp,
  formatConsoleUsd,
} from "@llmingress/db/console-format";
import { listProviders } from "@llmingress/db/console-providers";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";
import { ConsoleDialog } from "../_components/console-dialog";
import { FlatIcon } from "../_components/flat-icon";
import { Pagination } from "../_components/pagination";
import { buildQueryHref, readPageParam } from "../_lib/pagination";
import {
  ActivityStatusPill,
  type ConsoleSearchParams,
  formatActivityProviderLabel,
  formatActivityVirtualModelLabel,
  formatDateTime,
  readSingleSearchParam,
} from "./sections";

const ACTIVITY_PAGE_SIZE = 20;

function formatActivityLatency(latencyMs: number | null): string {
  if (latencyMs === null) {
    return "—";
  }
  return `${(latencyMs / 1000).toFixed(2)}s`;
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

  return (
    <ConsoleDialog
      ariaLabelledby="activity-detail-title"
      className="console-dialog activity-detail-dialog"
      closeHref={closeHref}
      initialFocus="close"
      triggerId={`activity-${activity.id}-trigger`}
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
          <p className="activity-empty-timeline">No fallback attempts</p>
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
    </ConsoleDialog>
  );
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
  return activity.fallbackFailedAttemptCount;
}

type ActivityRange = "24h" | "7d" | "30d";

const routeStrategyLabels: Record<string, string> = {
  cost_first: "Cost First",
  fixed: "Fixed",
  random: "Random",
};

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
    return routeStrategyLabels[routeReason.strategy] ?? routeReason.strategy;
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
export async function ActivitySection({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const page = readPageParam(searchParams);
  const selectedActivityId = readSingleSearchParam(searchParams.activityId);
  const activityRange = parseActivityRange(readSingleSearchParam(searchParams.activityRange));
  const filters = {
    agentId: readSingleSearchParam(searchParams.agentId),
    from: getActivityWindowStart(new Date(), activityRange),
    providerId: readSingleSearchParam(searchParams.providerId),
    requestIdQuery: readSingleSearchParam(searchParams.q),
    status: readSingleSearchParam(searchParams.status),
    virtualModelId: readSingleSearchParam(searchParams.virtualModelId),
  } satisfies ConsoleActivityFiltersInput;
  const [agents, virtualModels, providers, total, activities] = await Promise.all([
    listAgents(),
    listVirtualModels(),
    listProviders(),
    countConsoleActivities({ filters }),
    listConsoleActivities({ filters, limit: ACTIVITY_PAGE_SIZE, page }),
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
    from: total === 0 ? 0 : (page - 1) * ACTIVITY_PAGE_SIZE + 1,
    items: activities,
    page,
    to: total === 0 ? 0 : (page - 1) * ACTIVITY_PAGE_SIZE + activities.length,
    total,
    totalPages: Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)),
  };

  return (
    <section className="activity-workspace" id="activity" aria-label="Activity">
      <form className="activity-filter-grid" action="/activity" method="get">
        <div className="console-field">
          <label htmlFor="activity-agent">Agent</label>
          <select id="activity-agent" name="agentId" defaultValue={filters.agentId ?? ""}>
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
            <table className="data-table bounded-table activity-table">
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
                        <a
                          href={buildQueryHref(searchParams, { activityId: activity.id })}
                          id={`activity-${activity.id}-trigger`}
                        >
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
          <Pagination
            ariaLabel="Activity pages"
            from={view.from}
            itemLabel="activities"
            page={view.page}
            searchParams={searchParams}
            to={view.to}
            total={view.total}
            totalPages={view.totalPages}
          />
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
