import { deleteConsoleSession, sessionCookieName } from "@llmingress/db/console-auth";
import type { NextRequest } from "next/server";
import { withConsoleOrigin } from "../../_auth";
import { redirectToConsolePath } from "../../_redirect";

export const POST = withConsoleOrigin(async (request: NextRequest) => {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  await deleteConsoleSession(sessionToken);

  const response = redirectToConsolePath("/");
  response.cookies.delete(sessionCookieName);
  return response;
}, "Logout failed.");
