import {
  getSessionCookieOptions,
  loginConsoleAdmin,
  sessionCookieName,
} from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const password = await readPassword(request);
  if (!password) {
    return NextResponse.json({ error: "Admin password is required." }, { status: 400 });
  }

  const session = await loginConsoleAdmin(password);
  if (!session) {
    return NextResponse.json({ error: "Invalid admin password." }, { status: 401 });
  }

  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.cookies.set(
    sessionCookieName,
    session.token,
    getSessionCookieOptions(session.expiresAt),
  );
  return response;
}

async function readPassword(request: NextRequest): Promise<string | undefined> {
  const form = await request.formData();
  const password = form.get("password");
  return typeof password === "string" ? password : undefined;
}
