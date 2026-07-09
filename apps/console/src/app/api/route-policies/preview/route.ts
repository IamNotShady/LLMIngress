import { previewRoutePolicy } from "@llmingress/db/console-route-preview";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../../_auth";
import { consoleActionErrorResponse } from "../../_errors";

export const POST = withConsoleAuth(async (request) => {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRoutePolicy({ request: body }));
  } catch (error) {
    return consoleActionErrorResponse(error, "Route preview failed.");
  }
});
