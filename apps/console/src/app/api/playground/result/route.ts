import { type NextRequest, NextResponse } from "next/server";
import { getConsoleActivityDetail } from "../../../../server/activity";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../../server/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const requestId = request.nextUrl.searchParams.get("requestId")?.trim();
  if (!requestId) {
    return NextResponse.json({ error: "requestId is required." }, { status: 400 });
  }

  const detail = await getConsoleActivityDetail({ databaseUrl, requestId });
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
