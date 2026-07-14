import {
  getSessionCookieOptions,
  loginConsoleAdmin,
  sessionCookieName,
} from "@llmingress/db/console-auth";
import { consoleValidationError } from "@llmingress/db/console-operation-error";
import { type NextRequest, NextResponse } from "next/server";
import { withConsoleErrorBoundary } from "../../_auth";
import { redirectToConsolePath } from "../../_redirect";

export const POST = withConsoleErrorBoundary(async (request: NextRequest) => {
  const password = await readPassword(request);
  if (!password) {
    throw consoleValidationError("Admin password is required.", "form_field_required", {
      field: "password",
    });
  }

  const session = await loginConsoleAdmin(password);
  if (!session) {
    return NextResponse.json(
      { error: "Invalid admin password.", code: "invalid_admin_password" },
      { status: 401 },
    );
  }

  const response = redirectToConsolePath("/");
  response.cookies.set(
    sessionCookieName,
    session.token,
    getSessionCookieOptions(session.expiresAt),
  );
  return response;
}, "Login failed.");

async function readPassword(request: NextRequest): Promise<string | undefined> {
  const form = await request.formData();
  const password = form.get("password");
  return typeof password === "string" ? password : undefined;
}
