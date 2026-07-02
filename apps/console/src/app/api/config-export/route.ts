import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { exportConsoleConfig } from "@llmingress/db/console-import-export";
import { type NextRequest, NextResponse } from "next/server";

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
