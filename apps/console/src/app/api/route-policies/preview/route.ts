import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../../server/auth";
import { previewRoutePolicy } from "../../../../server/route-preview";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const body = await request.json();
    return NextResponse.json(await previewRoutePolicy({ databaseUrl, request: body }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Route preview failed." },
      { status: 400 },
    );
  }
}
