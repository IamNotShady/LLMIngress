import { getConsoleActivityDetail } from "@llmingress/db/console-activity";
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
      // What the policy weighed and took off the table. The Playground is where
      // a route is being worked out, and a candidate that never got an attempt
      // is the part of the answer the response body cannot show.
      filteredCandidates: detail.routeCandidates
        .filter((candidate) => !candidate.eligible)
        .map((candidate) => ({
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
      status: activity.status,
      totalCostUsd: activity.totalCostUsd,
      totalTokens: activity.totalTokens,
      virtualModelName: activity.virtualModelName,
    },
  });
});
