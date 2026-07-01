import { type NextRequest, NextResponse } from "next/server";
import { sessionCookieName, verifyConsoleSession } from "../../../server/auth";
import { exportConsoleConfig } from "../../../server/import-export";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const exported = await exportConsoleConfig();
  return new NextResponse(`${JSON.stringify(exported, null, 2)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="llmingress-config-export.json"',
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}
