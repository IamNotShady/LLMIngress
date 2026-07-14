import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";
import { consoleActionErrorResponse } from "./_errors";

type ConsoleRouteHandler = (request: NextRequest) => Promise<NextResponse> | NextResponse;

export function withConsoleErrorBoundary(
  handler: ConsoleRouteHandler,
  fallbackMessage = "Console action failed.",
): ConsoleRouteHandler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      return consoleActionErrorResponse(error, fallbackMessage);
    }
  };
}

export function withConsoleAuth(
  handler: ConsoleRouteHandler,
  fallbackMessage = "Console action failed.",
): ConsoleRouteHandler {
  return withConsoleErrorBoundary(async (request) => {
    const sessionToken = request.cookies.get(sessionCookieName)?.value;
    if (!(await verifyConsoleSession(sessionToken))) {
      return NextResponse.json(
        { error: "Authentication required.", code: "authentication_required" },
        { status: 401 },
      );
    }
    return handler(request);
  }, fallbackMessage);
}
