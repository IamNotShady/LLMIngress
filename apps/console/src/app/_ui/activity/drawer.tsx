import type { ConsoleActivityDetail } from "@llmingress/db/console-activity";
import {
  formatConsoleActivityMetadata,
  formatConsoleActivityRouteReason,
} from "@llmingress/db/console-activity";
import { StatusDot } from "../controls";
import { formatCompact, formatCost, formatLatency, formatOffset, formatStamp } from "../format";
import { DetailRow, SectionTitle } from "../layout";
import { Drawer } from "../overlay";
import { buildHref, type SearchParams } from "../params";
import { activityStatusTone, attemptTone } from "./model";

export function ActivityDrawer({
  detail,
  params,
}: {
  detail: ConsoleActivityDetail;
  params: SearchParams;
}) {
  const { activity, fallbackEvents, requestMetadata, routeCandidates } = detail;
  // The candidates the chain never reached. The router does not rule a
  // candidate out before trying it — it orders them and stops at the first that
  // serves — so this is "did not get a turn", which is a fact about the order
  // and not a verdict about the candidate.
  const untried = routeCandidates.filter((candidate) => candidate.attempt === "none");
  // An answer that took more than one candidate to get: the status alone says
  // 200 and hides that the first choice failed on the way there.
  const servedByFallback =
    activity.status === "succeeded" && activity.fallbackFailedAttemptCount > 0;
  const metadataLines = formatConsoleActivityMetadata(requestMetadata);
  const tokens =
    activity.inputTokens === null && activity.outputTokens === null
      ? "—"
      : `${formatCompact(activity.inputTokens ?? 0)} in / ${formatCompact(
          activity.outputTokens ?? 0,
        )} out`;

  return (
    <Drawer
      closeHref={buildHref("/activity", params, { request: null })}
      subtitle={formatStamp(activity.startedAt)}
      title={activity.requestId}
      trailing={
        <span
          className={`flex items-center gap-[6px] rounded-xs border px-[9px] py-[3px] font-mono text-125 font-medium ${
            activity.status === "failed" || servedByFallback
              ? `border-ambbd bg-ambbg ${servedByFallback ? "text-ambtx" : activityStatusTone(activity.status)}`
              : `border-rule bg-track ${activityStatusTone(activity.status)}`
          }`}
        >
          <StatusDot tone={servedByFallback ? "amber" : attemptTone(activity.status)} />
          {activity.httpStatus ?? activity.status}
          {activity.errorCode ? ` ${activity.errorCode}` : ""}
          {servedByFallback ? " · served by fallback" : ""}
        </span>
      }
    >
      <div className="mt-4 border-t border-hair">
        <DetailRow label="api key" value={activity.apiKeyName ?? activity.apiKeyPrefix ?? "—"} />
        <DetailRow label="virtual model" value={activity.virtualModelName ?? "—"} />
        <DetailRow label="protocol" value={activity.protocol} />
        <DetailRow
          clip
          label="routed to"
          value={
            activity.providerDisplayName
              ? `${activity.providerDisplayName} · ${activity.providerModelName ?? "unknown model"}`
              : "no candidate served this request"
          }
        />
        <DetailRow label="strategy" value={activity.routePolicyStrategy ?? "—"} />
        <DetailRow label="tokens" value={tokens} />
        <DetailRow label="latency" value={formatLatency(activity.latencyMs)} />
        <DetailRow label="cost" value={formatCost(activity.totalCostUsd)} />
      </div>

      <SectionTitle className="mt-[18px]" note="offset from request start">
        {fallbackEvents.length > 1 ? "Route timeline" : "Route"}
      </SectionTitle>
      {/* Why this candidate and not another — the gateway records the reason
          it picked, and without it the timeline shows what happened but never
          why the route looked the way it did. */}
      <p className="mt-2 font-mono text-125 leading-[1.6] text-dim">
        {formatConsoleActivityRouteReason(activity.routeReason)}
      </p>
      {/* The other half of "why this provider": the timeline below says what
          was tried, and this says which of the policy's candidates the chain
          never got to. */}
      {untried.length > 0 ? (
        <div className="mt-2">
          <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">
            NOT ATTEMPTED
          </div>
          {untried.map((candidate) => (
            <div
              key={`${candidate.candidateOrder}-${candidate.providerModelId}`}
              className="mt-1 flex gap-[10px] font-mono text-12 leading-[1.5]"
            >
              <span className="flex-none text-faint tabnum">#{candidate.candidateOrder}</span>
              <span className="min-w-0 flex-1 text-dim">
                <span className="text-ink">{candidate.label}</span>
                {" — no attempt was recorded for it"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-2 border-t border-hair">
        {fallbackEvents.length === 0 ? (
          <p className="py-3 font-mono text-13 leading-[1.6] text-dim">
            No attempt was recorded — the request failed before a candidate was chosen.
          </p>
        ) : (
          fallbackEvents.map((event) => (
            <div
              key={event.attemptOrder}
              className="flex gap-[10px] border-b border-rule2 py-[9px]"
            >
              <span
                className={`mt-[3px] size-[7px] flex-none rounded-full ${
                  attemptTone(event.status) === "green"
                    ? "bg-green"
                    : attemptTone(event.status) === "red"
                      ? "bg-red"
                      : "bg-dim"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-3 font-mono text-13">
                  <span className="font-medium text-ink cell-clip">
                    attempt {event.attemptOrder} ·{" "}
                    {event.providerModelDisplayName ?? event.providerModelName ?? "unknown model"}
                    {event.providerApiKeyPrefix ? ` · ${event.providerApiKeyPrefix}` : ""}
                  </span>
                  <span className="flex-none text-faint tabnum">
                    {formatOffset(activity.startedAt, event.createdAt)}
                  </span>
                </div>
                <div
                  className={`mt-[2px] font-mono text-12 leading-[1.5] ${
                    event.status === "failed" ? "text-redtx" : "text-dim"
                  }`}
                >
                  {describeAttempt(event)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {fallbackEvents.some((event) => event.failedBeforeFirstByte) ? (
        <p className="mt-2 font-mono text-12 leading-[1.6] text-faint">
          Retries happen before the first byte only — once streaming starts the gateway never
          replays a request.
        </p>
      ) : null}

      <SectionTitle className="mt-[18px]">Request metadata</SectionTitle>
      <pre className="mt-2 whitespace-pre-wrap rounded-xs border border-rule bg-track px-3 py-[10px] font-mono text-125 leading-[1.6] text-ink">
        {metadataLines.length > 0 ? metadataLines.join("\n") : "no metadata recorded"}
      </pre>
      <p className="mt-[10px] font-mono text-125 leading-[1.6] text-faint">
        Prompts, successful responses, tool arguments and credentials are never stored in
        operational logs.
      </p>
    </Drawer>
  );
}

function describeAttempt(event: ConsoleActivityDetail["fallbackEvents"][number]): string {
  if (event.status === "skipped") {
    return `skipped · ${event.errorCode ?? "candidate unavailable"}`;
  }
  if (event.status === "succeeded") {
    return `${event.statusCode ?? 200} · served to the client`;
  }
  return [
    `${event.statusCode ?? "no status"} ${event.errorCode ?? "failed"}`,
    event.failedBeforeFirstByte ? "failed before first byte" : "failed mid-stream, not replayable",
    event.retryable === null ? null : event.retryable ? "retryable" : "not retryable",
  ]
    .filter(Boolean)
    .join(" · ");
}
