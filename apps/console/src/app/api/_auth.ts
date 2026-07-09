import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";

type ConsoleRouteHandler = (request: NextRequest) => Promise<NextResponse> | NextResponse;

export function withConsoleAuth(handler: ConsoleRouteHandler): ConsoleRouteHandler {
  return async (request) => {
    const sessionToken = request.cookies.get(sessionCookieName)?.value;
    if (!(await verifyConsoleSession(sessionToken))) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    return handler(request);
  };
}
