import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import { exportConsoleConfig } from "../../../server/import-export";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const exported = await exportConsoleConfig({ databaseUrl });
  return new NextResponse(`${JSON.stringify(exported, null, 2)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="llmingress-config-export.json"',
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}
