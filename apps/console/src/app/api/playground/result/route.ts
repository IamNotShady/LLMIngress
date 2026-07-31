import {
  getConsoleActivityDetail,
  readConsoleActivityRouteTag,
} from "@llmingress/db/console-activity";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../../_auth";

export const GET = withConsoleAuth(async (request) => {
  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  if (!requestId) {
    return NextResponse.json(
      { error: "requestId is required.", code: "request_id_required" },
      { status: 400 },
    );
  }

  const detail = await getConsoleActivityDetail({ requestId });
  if (!detail) {
    return NextResponse.json({ detail: null }, { status: 404 });
  }

  const activity = detail.activity;
  return NextResponse.json({
    detail: {
      // Every candidate the router recorded for this request and what became of
      // it. The Playground is where a route is being worked out, and what the
      // response body cannot show is which other candidates existed. An empty
      // list and a request with nothing recorded are different answers, so the
      // list is null when the route recorded no candidates at all.
      routeCandidates:
        detail.routeCandidates.length === 0
          ? null
          : detail.routeCandidates.map((candidate) => ({
              attempt: candidate.attempt,
              candidateOrder: candidate.candidateOrder,
              label: candidate.label,
              reasons: candidate.reasons,
            })),
      latencyMs: activity.latencyMs,
      providerDisplayName: activity.providerDisplayName,
      providerKey: activity.providerKey,
      providerModelDisplayName: activity.providerModelDisplayName,
      providerModelName: activity.providerModelName,
      requestId: activity.requestId,
      routePolicyStrategy: activity.routePolicyStrategy,
      // Which tag the request named and whether it matched. A tag that matched
      // nothing is served by the default candidate with a 200 that reads
      // exactly like a match, so the trace is the only place it shows.
      routeTag: readConsoleActivityRouteTag(activity.routeReason),
      status: activity.status,
      totalCostUsd: activity.totalCostUsd,
      totalTokens: activity.totalTokens,
      virtualModelName: activity.virtualModelName,
    },
  });
});
