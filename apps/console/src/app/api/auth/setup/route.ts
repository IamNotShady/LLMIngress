import { createAdminPassword } from "@llmingress/db/console-auth";
import { consoleValidationError } from "@llmingress/db/console-operation-error";
import type { NextRequest } from "next/server";
import { withConsoleErrorBoundary } from "../../_auth";
import { consoleActionErrorResponse } from "../../_errors";
import { redirectToConsolePath } from "../../_redirect";

export const POST = withConsoleErrorBoundary(async (request: NextRequest) => {
  const form = await request.formData();
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
