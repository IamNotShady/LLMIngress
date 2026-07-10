import { createAdminPassword } from "@llmingress/db/console-auth";
import { consoleValidationError } from "@llmingress/db/console-operation-error";
import type { NextRequest } from "next/server";
import { withConsoleOrigin } from "../../_auth";
import { consoleActionErrorResponse } from "../../_errors";
import { redirectToConsolePath } from "../../_redirect";

export const POST = withConsoleOrigin(async (request: NextRequest) => {
  const password = await readPassword(request);
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

async function readPassword(request: NextRequest): Promise<string | undefined> {
  const form = await request.formData();
  const password = form.get("password");
  return typeof password === "string" ? password : undefined;
}
