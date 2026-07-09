import { deleteConsoleSession, sessionCookieName } from "@llmingress/db/console-auth";
import type { NextRequest } from "next/server";
import { redirectToConsolePath } from "../../_redirect";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  await deleteConsoleSession(sessionToken);

  const response = redirectToConsolePath("/");
  response.cookies.delete(sessionCookieName);
  return response;
}
