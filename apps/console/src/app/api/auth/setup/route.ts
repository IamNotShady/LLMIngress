import { readConsoleSetupMode } from "@llmingress/config";
import { createAdminPassword, isConsoleInitialized } from "@llmingress/db/console-auth";
import { consoleValidationError } from "@llmingress/db/console-operation-error";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withConsoleOrigin } from "../../_auth";
import { consoleActionErrorResponse } from "../../_errors";
import { redirectToConsolePath } from "../../_redirect";

export const POST = withConsoleOrigin(async (request: NextRequest) => {
  if (await isConsoleInitialized()) {
    return NextResponse.json(
      { error: "Console is already initialized.", code: "console_already_initialized" },
      { status: 409 },
    );
  }

  const setupMode = readConsoleSetupMode();
  if (setupMode.kind === "locked") {
    return NextResponse.json(
      {
        error: "Console setup is locked until CONSOLE_SETUP_TOKEN is configured.",
        code: "console_setup_locked",
      },
      { status: 503 },
    );
  }

  const form = await request.formData();
  if (setupMode.kind === "token_required" && readText(form, "setupToken") !== setupMode.token) {
    return NextResponse.json(
      { error: "Console setup token is invalid.", code: "console_setup_token_invalid" },
      { status: 403 },
    );
  }

  const password = readText(form, "password");
  if (!password) {
    throw consoleValidationError("Admin password is required.", "form_field_required", {
      field: "password",
    });
  }

  try {
    await createAdminPassword(password);
  } catch (error) {
    return consoleActionErrorResponse(error, "Failed to create admin.");
  }

  return redirectToConsolePath("/");
}, "Failed to create admin.");

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}
