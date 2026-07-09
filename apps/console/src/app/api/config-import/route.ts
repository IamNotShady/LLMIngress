import { importConsoleConfig } from "@llmingress/db/console-import-export";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const configJson = readRequiredText(form, "configJson");
    const document: unknown = JSON.parse(configJson);
    const result = await importConsoleConfig({
      document,
    });
    const redirectUrl = new URL("/settings", request.url);
    redirectUrl.searchParams.set("configImportVersion", String(result.version));
    return redirectToConsolePath(redirectUrl);
  } catch (error) {
    return consoleActionErrorResponse(error, "Config import failed.");
  }
});
