import { getConsoleActivityDetail } from "@llmingress/db/console-activity";
import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  if (!requestId) {
    return NextResponse.json({ error: "requestId is required." }, { status: 400 });
  }

  const detail = await getConsoleActivityDetail({ requestId });
  if (!detail) {
    return NextResponse.json({ detail: null }, { status: 404 });
  }

  const activity = detail.activity;
  return NextResponse.json({
    detail: {
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
}
