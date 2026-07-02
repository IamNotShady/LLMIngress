import { deleteConsoleSession, sessionCookieName } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  await deleteConsoleSession(sessionToken);

  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.cookies.delete(sessionCookieName);
  return response;
}
