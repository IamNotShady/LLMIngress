import { consolePublicBaseUrl, validateConsoleOrigin } from "@llmingress/config";
import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";
import { consoleActionErrorResponse } from "./_errors";

type ConsoleRouteHandler = (request: NextRequest) => Promise<NextResponse> | NextResponse;

export function withConsoleOrigin(
  handler: ConsoleRouteHandler,
  fallbackMessage = "Console action failed.",
): ConsoleRouteHandler {
  return async (request) => {
    const originFailure = validateConsoleRequestOrigin(request);
    if (originFailure) {
      return originFailure;
    }
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
  return withConsoleOrigin(async (request) => {
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

export function validateConsoleRequestOrigin(
  request: NextRequest,
  configuredOrigin: string | null = consolePublicBaseUrl(),
): NextResponse | null {
  const result = validateConsoleOrigin({
    configuredOrigin,
    method: request.method,
    originHeader: request.headers.get("origin"),
    requestUrl: request.url,
  });
  return result.ok
    ? null
    : NextResponse.json({ error: result.error, code: result.code }, { status: 403 });
}
